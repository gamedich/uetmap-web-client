// ==========================================
// 4. vehicles_layer.js: Опрос, симуляция и маркеры вагонов
// ==========================================
(function() {
  try {
    const activeMarkers = new Map(); // id -> L.marker
    let telemetryWs = null;
    let vehicleSimulations = [];
    let vehicleAnimFrame = null;
    let lastSimTime = performance.now();
    let lastUpsertTime = 0;

    window.calculateBearing = function(lat1, lon1, lat2, lon2) {
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
      const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
      let brng = Math.atan2(y, x) * 180 / Math.PI;
      return (brng + 360) % 360;
    };

    window.isRouteOperatingNow = function(routeNum) {
      try {
        const ulyanovskDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Samara' }));
        const hours = ulyanovskDate.getHours();
        const minutes = ulyanovskDate.getMinutes();
        const currentDec = hours + minutes / 60;
        const numStr = String(routeNum).trim();

        if (currentDec >= 22.0 || currentDec < 5.5) {
          if (['22', '4'].includes(numStr) && currentDec <= 23.5) {
            return true;
          }
          return false;
        }
        if (currentDec >= 21.5 && !['22', '4', '22К'].includes(numStr)) {
          return false;
        }
        return true;
      } catch (e) {
        return true;
      }
    };

    // Отслеживание времени простоя (speed < 1 км/ч) для индикации «⚠️ Затор / Простой» (ШАГ 7.2)
    const stationaryTimestamps = new Map(); // id -> timestamp when stopped
    window.adminFleetFilter = 'all'; // 'all', 'on_line', 'depot'

    window.setFleetFilter = function(filterVal) {
      window.adminFleetFilter = filterVal;
      window.updateVehiclesVisibility();
    };

    window.renderVehicleMarker = function(v) {
      const typeColor = v.type === 'trolley' ? '#06b6d4' : '#ef4444';
      const bearing = v.bearing || 0;
      const destName = v.destStop || (v.direction === 1 ? 'В сторону Центра / Севера' : 'В сторону УКСМ / Юга');
      const speed = Math.round(v.speed || v.speedKmH || 0);
      const isOnline = (v.fleet_status || 'on_line') === 'on_line';

      // Проверка затора: speed < 1 км/ч дольше 3 минут (180 сек)
      const now = Date.now();
      let isStalled = false;
      if (isOnline && speed < 1) {
        if (!stationaryTimestamps.has(v.id)) {
          stationaryTimestamps.set(v.id, now);
        } else {
          const stoppedDurationSec = (now - stationaryTimestamps.get(v.id)) / 1000;
          if (stoppedDurationSec >= 180) {
            isStalled = true;
          }
        }
      } else {
        stationaryTimestamps.delete(v.id);
      }

      const stallClass = isStalled ? 'ring-2 ring-rose-500 ring-offset-1' : '';
      const stallBadge = isStalled ? '<div class="absolute -top-2 -right-2 bg-rose-600 text-white rounded-full text-[8px] px-1 font-bold shadow-md">⚠️ Затор</div>' : '';

      const iconHtml = `
        <div class="vehicle-pin ${stallClass}" style="background-color: ${typeColor}; color: #ffffff; transform: rotate(${Math.round(bearing)}deg); position: relative;">
          ${stallBadge}
          <div class="vehicle-arrow"></div>
          <span style="font-size: 11px; font-weight: 800; font-family: 'JetBrains Mono', monospace; transform: rotate(${-Math.round(bearing)}deg);">${window.escapeHtml(v.route_number || v.routeNum || '')}</span>
        </div>
      `;

      const icon = L.divIcon({
        className: 'vehicle-marker-wrapper',
        html: iconHtml,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18]
      });

      const marker = L.marker([v.lat, v.lon || v.lng], {
        icon: icon,
        zIndexOffset: isStalled ? 900 : 500
      });
      marker._uetRouteNum = String(v.route_number || v.routeNum || '').trim();
      marker._uetVehicle = v;

      const stallTooltip = isStalled ? ' [⚠️ Затор / Простой > 3 мин]' : '';
      marker.bindTooltip(`№ ${marker._uetRouteNum} ➔ ${window.escapeHtml(destName)}${stallTooltip}`, {
        direction: 'top',
        className: 'bg-slate-900 text-white text-[10px] font-semibold px-2 py-1 rounded-lg border border-slate-700 shadow-xl'
      });

      marker.bindPopup(() => `
        <div class="space-y-1.5 p-1 min-w-[220px]">
          <div class="flex items-center justify-between border-b border-slate-800 pb-1">
            <div class="flex items-center gap-1.5">
              <span class="w-6 h-6 rounded flex items-center justify-center font-mono font-bold text-xs" style="background:${typeColor}25; color:${typeColor}; border:1px solid ${typeColor}50;">
                № ${window.escapeHtml(v.route_number || v.routeNum || '')}
              </span>
              <span class="text-xs font-bold text-white">${v.type === 'trolley' ? 'Троллейбус' : 'Трамвай'}</span>
            </div>
            <span class="px-1.5 py-0.5 rounded text-[9px] font-mono ${isOnline ? (isStalled ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40') : 'bg-slate-800 text-slate-300'}">
              ${isStalled ? '⚠️ ПРОСТОЙ' : (v.fleet_status || 'ONLINE')}
            </span>
          </div>
          <div class="text-[11px] text-slate-300 flex justify-between">
            <span>Скорость:</span>
            <span class="font-mono ${speed < 1 && isOnline ? 'text-rose-400 font-bold' : 'text-white'}">${speed} км/ч</span>
          </div>
          ${v.depot ? `
          <div class="text-[11px] text-slate-300 flex justify-between">
            <span>Депо:</span>
            <span class="text-amber-300 text-[10px] font-medium">${window.escapeHtml(v.depot)}</span>
          </div>
          ` : ''}
          ${v.driver_tab ? `
          <div class="text-[11px] text-slate-300 flex justify-between">
            <span>Водитель (таб):</span>
            <span class="font-mono text-cyan-300 text-[10px]">${window.escapeHtml(v.driver_tab)}</span>
          </div>
          ` : ''}
          <div class="text-[11px] text-amber-300 flex items-start gap-1">
            <span class="text-slate-400 shrink-0">Следование:</span>
            <span class="font-medium truncate">${window.escapeHtml(destName)}</span>
          </div>
          <div class="text-[10px] text-slate-400 flex justify-between pt-0.5 border-t border-slate-800 mt-1">
            <span>Время (UTC+4):</span>
            <span class="font-mono text-emerald-400">${new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Samara', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      `);

      // Клик по вагону: подсвечиваем его маршрут
      marker.on('click', () => {
        const routeNum = v.route_number || v.routeNum || marker._uetRouteNum;
        if (routeNum && typeof window.selectRoute === 'function') {
          window.selectRoute(routeNum);
        }
      });

      return marker;
    };

    window.isVehicleRouteVisible = function(routeNum, vehObj) {
      // Проверка фильтра парка в админке
      if (window.adminFleetFilter && window.adminFleetFilter !== 'all' && vehObj) {
        const fStatus = vehObj.fleet_status || 'on_line';
        if (window.adminFleetFilter === 'on_line' && fStatus !== 'on_line') return false;
        if (window.adminFleetFilter === 'depot' && fStatus === 'on_line') return false;
      }

      if (!window.isRouteOperatingNow(routeNum)) return false;

      if (window.activeFilter !== 'all') {
        const rMatch = (window.routes || []).find(item => String(item.number).trim() === String(routeNum).trim());
        if (rMatch && rMatch.type !== window.activeFilter) return false;
      }

      if (window.selectedRouteId === 'all') return true;
      const r = (window.routes || []).find(item => item.id === window.selectedRouteId);
      if (!r) return true;
      return String(r.number).trim() === String(routeNum).trim();
    };

    window.updateVehiclesVisibility = function() {
      if (!window.vehiclesGroup) return;

      if (!window.isVehiclesLiveEnabled) {
        window.vehiclesGroup.clearLayers();
        if (window.map && window.map.hasLayer(window.vehiclesGroup)) {
          window.map.removeLayer(window.vehiclesGroup);
        }
        return;
      }

      if (window.map && !window.map.hasLayer(window.vehiclesGroup)) {
        window.map.addLayer(window.vehiclesGroup);
      }

      for (const [id, marker] of activeMarkers.entries()) {
        const veh = marker._uetVehicle || vehicleSimulations.find(v => v.id === id);
        const routeNum = marker._uetRouteNum || (veh ? veh.route_number || veh.routeNum : '');

        if (window.isVehicleRouteVisible(routeNum, veh)) {
          if (!window.vehiclesGroup.hasLayer(marker)) window.vehiclesGroup.addLayer(marker);
        } else {
          if (window.vehiclesGroup.hasLayer(marker)) window.vehiclesGroup.removeLayer(marker);
        }
      }
    };

    window.handleTelemetryUpdate = function(liveVehiclesList) {
      if (!window.vehiclesGroup || !Array.isArray(liveVehiclesList)) return;

      const currentActiveIds = new Set(liveVehiclesList.map(v => v.id));
      const simIds = new Set((vehicleSimulations || []).map(v => v.id));

      for (const [id, marker] of activeMarkers.entries()) {
        if (!simIds.has(id) && !currentActiveIds.has(id)) {
          if (window.vehiclesGroup.hasLayer(marker)) {
            window.vehiclesGroup.removeLayer(marker);
          }
          activeMarkers.delete(id);
          stationaryTimestamps.delete(id);
        }
      }

      for (const v of liveVehiclesList) {
        const marker = activeMarkers.get(v.id);
        const lat = v.lat;
        const lon = v.lon || v.lng;

        if (marker) {
          marker.setLatLng([lat, lon]);
          marker._uetVehicle = v;
        } else {
          const newMarker = window.renderVehicleMarker(v);
          activeMarkers.set(v.id, newMarker);
          if (window.isVehiclesLiveEnabled && window.isVehicleRouteVisible(v.route_number || v.routeNum, v)) {
            window.vehiclesGroup.addLayer(newMarker);
          }
        }
      }
      window.updateVehiclesVisibility();
    };

    window.syncVehiclesState = async function() {
      try {
        const isAdmin = window.location.pathname.includes('admin') || !!document.getElementById('admin-fleet-filter');
        const apiBase = window.API_BASE || '/map/api';
        const url = isAdmin ? `${apiBase}/vehicles?scope=all` : `${apiBase}/vehicles`;
        const res = await fetch(url);
        if (res.ok) {
          const liveVehicles = await res.json();
          window.handleTelemetryUpdate(liveVehicles);
        }
      } catch (e) {
        console.error('[vehicles_layer.js] Vehicles sync error:', e);
      }
    };

    window.initTelemetryWebSocket = function() {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPrefix = window.location.pathname.startsWith('/map') ? '/map/ws/telemetry' : '/ws/telemetry';
        const wsUrl = `${proto}//${window.location.host}${wsPrefix}`;
        telemetryWs = new WebSocket(wsUrl);

        telemetryWs.onopen = () => {
          console.log('[vehicles_layer.js] Telemetry WebSocket connected');
        };

        telemetryWs.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.event === 'INITIAL_SYNC' && Array.isArray(data.vehicles)) {
              window.handleTelemetryUpdate(data.vehicles);
            } else if (data.event === 'VEHICLES_TELEMETRY' && Array.isArray(data.vehicles)) {
              data.vehicles.forEach(v => {
                const marker = activeMarkers.get(v.id);
                if (marker) {
                  marker.setLatLng([v.lat, v.lon]);
                } else {
                  const newMarker = window.renderVehicleMarker(v);
                  activeMarkers.set(v.id, newMarker);
                  if (window.isVehiclesLiveEnabled && window.isVehicleRouteVisible(v.route_number)) {
                    window.vehiclesGroup.addLayer(newMarker);
                  }
                }
              });
            } else if (data.event === 'CLOSURE_RESOLVED' || data.event === 'INCIDENT_RESOLVED' || data.event === 'ALERT_DISMISSED') {
              if (typeof window.fetchClosures === 'function') window.fetchClosures();
              if (typeof window.fetchIncidents === 'function') window.fetchIncidents();
              if (typeof window.loadAdminIncidents === 'function') window.loadAdminIncidents();
              if (typeof window.fetchPoints === 'function') window.fetchPoints();
            } else if (data.event === 'CLOSURE_CREATED' || data.event === 'INCIDENT_CREATED') {
              if (typeof window.fetchClosures === 'function') window.fetchClosures();
              if (typeof window.fetchIncidents === 'function') window.fetchIncidents();
              if (typeof window.loadAdminIncidents === 'function') window.loadAdminIncidents();
              if (typeof window.fetchPoints === 'function') window.fetchPoints();
            }
          } catch (err) {
            console.error('WS message parse error:', err);
          }
        };

        telemetryWs.onclose = () => {
          setTimeout(window.initTelemetryWebSocket, 4000);
        };
      } catch (e) {
        console.warn('WS not available, fallback to polling', e);
      }
    };

    window.initVehicleSimulation = function() {
      try {
        const routes = window.routes || [];
        if (routes.length === 0) return;

        vehicleSimulations = [];
        const simConfig = [
          { routeNum: '22', type: 'tram', color: '#ef4444', cars: ['214', '228', '198', '205', '219', '241'], speed: 20 },
          { routeNum: '22К', type: 'tram', color: '#ef4444', cars: ['215', '230'], speed: 20 },
          { routeNum: '4',  type: 'tram', color: '#ef4444', cars: ['172', '189', '194', '202'], speed: 20 },
          { routeNum: '15', type: 'tram', color: '#ef4444', cars: ['231', '245', '256'], speed: 19 },
          { routeNum: '1',  type: 'tram', color: '#ef4444', cars: ['142', '155'], speed: 18 },
          { routeNum: '6',  type: 'tram', color: '#ef4444', cars: ['163', '170'], speed: 19 },
          { routeNum: '9',  type: 'tram', color: '#ef4444', cars: ['112', '125'], speed: 18 },
          { routeNum: '10', type: 'tram', color: '#ef4444', cars: ['130', '139'], speed: 18 },
          { routeNum: '11', type: 'tram', color: '#ef4444', cars: ['148', '159'], speed: 18 },
          { routeNum: '107', type: 'tram', color: '#ef4444', cars: ['1071', '1072'], speed: 22 },
          { routeNum: '5',  type: 'tram', color: '#ef4444', cars: ['151', '164'], speed: 18 },
          { routeNum: '19', type: 'tram', color: '#ef4444', cars: ['191', '197'], speed: 18 },
          { routeNum: '12', type: 'trolley', color: '#06b6d4', cars: ['114', '126', '133', '140'], speed: 22 },
          { routeNum: '1',  type: 'trolley', color: '#06b6d4', cars: ['108', '115'], speed: 20 },
          { routeNum: '1а', type: 'trolley', color: '#06b6d4', cars: ['101', '117'], speed: 20 },
          { routeNum: '2',  type: 'trolley', color: '#06b6d4', cars: ['103', '121'], speed: 20 },
          { routeNum: '3',  type: 'trolley', color: '#06b6d4', cars: ['104', '109'], speed: 19 },
          { routeNum: '4',  type: 'trolley', color: '#06b6d4', cars: ['106', '119'], speed: 20 },
          { routeNum: '4а', type: 'trolley', color: '#06b6d4', cars: ['110', '124'], speed: 20 },
          { routeNum: '7',  type: 'trolley', color: '#06b6d4', cars: ['127', '135'], speed: 20 }
        ];

        simConfig.forEach(cfg => {
          const r = routes.find(item => String(item.number).trim() === String(cfg.routeNum).trim() && item.type === cfg.type);
          const poly = (r && r.poly_coordinates && r.poly_coordinates.length > 5) ? r.poly_coordinates : null;
          if (!poly) return;

          let trackLengthKm = 0;
          for (let i = 0; i < poly.length - 1; i++) {
            const dlat = (poly[i][0] - poly[i+1][0]) * 111.13;
            const dlng = (poly[i][1] - poly[i+1][1]) * 64.8;
            trackLengthKm += Math.sqrt(dlat * dlat + dlng * dlng);
          }
          if (trackLengthKm < 1) trackLengthKm = 15;

          const isRing = ['9', '10'].includes(String(cfg.routeNum).trim());

          cfg.cars.forEach((carNum, idx) => {
            const dir = isRing ? 1 : (idx % 2 === 0 ? 1 : -1);
            const initialProg = (idx + 0.25) / cfg.cars.length;
            const pIdx = Math.min(poly.length - 1, Math.floor(initialProg * poly.length));

            vehicleSimulations.push({
              id: `${cfg.type}_${cfg.routeNum}_${carNum}`,
              routeNum: cfg.routeNum,
              type: cfg.type,
              wagonNumber: carNum,
              color: cfg.color,
              poly: poly,
              trackLengthKm: trackLengthKm,
              isRing: isRing,
              progress: initialProg,
              speedKmH: cfg.speed + (idx % 3),
              direction: dir,
              dwellTime: (idx * 3) % 10,
              lat: poly[pIdx][0],
              lng: poly[pIdx][1]
            });
          });
        });

        startVehicleAnimationLoop();
      } catch (err) {
        console.error('[vehicles_layer.js] Error in initVehicleSimulation:', err);
      }
    };

    function startVehicleAnimationLoop() {
      if (vehicleAnimFrame) cancelAnimationFrame(vehicleAnimFrame);

      function step(now) {
        const delta = Math.min(100, now - lastSimTime);
        lastSimTime = now;

        if (window.isVehiclesLiveEnabled) {
          updateVehiclePositions(delta);

          // Периодически пушим свежие координаты в БД через UPSERT каждые 5 сек
          if (now - lastUpsertTime > 5000) {
            lastUpsertTime = now;
            const batch = vehicleSimulations.map(v => ({
              id: v.id,
              route_number: v.routeNum,
              type: v.type,
              lat: v.lat,
              lon: v.lng,
              speed: v.speedKmH,
              bearing: 0
            }));
            fetch('/map/api/vehicles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(batch)
            }).catch(() => null);
          }
        }

        vehicleAnimFrame = requestAnimationFrame(step);
      }

      vehicleAnimFrame = requestAnimationFrame(step);
    }

    function updateVehiclePositions(deltaMs) {
      const dt = deltaMs / 1000;

      vehicleSimulations.forEach(veh => {
        if (veh.dwellTime > 0) {
          veh.dwellTime -= dt;
          return;
        }

        if (!veh.poly || veh.poly.length < 2) return;

        const speedMs = ((veh.speedKmH || 18) / 3.6);
        const metersDelta = speedMs * dt;
        const trackLengthMeters = Math.max(1000, (veh.trackLengthKm || 15) * 1000);
        const progressDelta = metersDelta / trackLengthMeters;

        veh.progress += veh.direction * progressDelta;

        const isRing = veh.isRing || ['9', '10'].includes(String(veh.routeNum).trim());
        if (isRing) {
          if (veh.progress >= 1.0) {
            veh.progress = 0.0;
            veh.dwellTime = 12;
          } else if (veh.progress < 0.0) {
            veh.progress = 0.999;
            veh.dwellTime = 12;
          }
        } else {
          if (veh.progress >= 1.0) {
            veh.progress = 1.0;
            veh.direction = -1;
            veh.dwellTime = 15;
          } else if (veh.progress <= 0.0) {
            veh.progress = 0.0;
            veh.direction = 1;
            veh.dwellTime = 15;
          }
        }

        const totalPoints = veh.poly.length;
        const rawIdx = veh.progress * (totalPoints - 1);
        const idx1 = Math.floor(rawIdx);
        const idx2 = Math.min(totalPoints - 1, idx1 + 1);
        const segT = rawIdx - idx1;

        const p1 = veh.poly[idx1];
        const p2 = veh.poly[idx2];
        if (p1 && p2) {
          veh.lat = p1[0] + (p2[0] - p1[0]) * segT;
          veh.lng = p1[1] + (p2[1] - p1[1]) * segT;

          if (veh.direction === 1) {
            veh.bearing = window.calculateBearing(p1[0], p1[1], p2[0], p2[1]);
            veh.destStop = 'В сторону Центра / Севера';
          } else {
            veh.bearing = window.calculateBearing(p2[0], p2[1], p1[0], p1[1]);
            veh.destStop = 'В сторону УКСМ / Юга';
          }

          let marker = activeMarkers.get(veh.id);
          if (!marker) {
            marker = window.renderVehicleMarker(veh);
            activeMarkers.set(veh.id, marker);
            if (window.isVehiclesLiveEnabled && window.isVehicleRouteVisible(veh.routeNum)) {
              window.vehiclesGroup.addLayer(marker);
            }
          } else {
            marker.setLatLng([veh.lat, veh.lng]);
            const pinEl = marker.getElement()?.querySelector('.vehicle-pin');
            if (pinEl) {
              pinEl.style.transform = `rotate(${Math.round(veh.bearing)}deg)`;
              const labelEl = pinEl.querySelector('span');
              if (labelEl) labelEl.style.transform = `rotate(${-Math.round(veh.bearing)}deg)`;
            }
          }
        }
      });
    }

    window.toggleVehiclesLive = function() {
      window.isVehiclesLiveEnabled = !window.isVehiclesLiveEnabled;
      const btn = document.getElementById('btn-vehicles-toggle');
      if (btn) {
        if (window.isVehiclesLiveEnabled) {
          btn.classList.add('bg-amber-500/20', 'border-amber-500/40', 'text-amber-300');
          btn.classList.remove('bg-slate-900/90', 'border-slate-800', 'text-slate-400');
          btn.querySelector('.rounded-full')?.classList.add('bg-emerald-400', 'animate-pulse');
          btn.querySelector('.rounded-full')?.classList.remove('bg-slate-600');
          if (typeof window.showToast === 'function') window.showToast('Движение транспорта включено');
        } else {
          btn.classList.remove('bg-amber-500/20', 'border-amber-500/40', 'text-amber-300');
          btn.classList.add('bg-slate-900/90', 'border-slate-800', 'text-slate-400');
          btn.querySelector('.rounded-full')?.classList.remove('bg-emerald-400', 'animate-pulse');
          btn.querySelector('.rounded-full')?.classList.add('bg-slate-600');
          if (typeof window.showToast === 'function') window.showToast('Движение транспорта скрыто');
        }
      }
      window.updateVehiclesVisibility();
    };
  } catch (globalErr) {
    console.error('Global error in vehicles_layer.js:', globalErr);
  }
})();
