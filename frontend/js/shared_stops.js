// ==========================================
// 3. stops_layer.js: Остановки на статических координатах
// ==========================================
(function() {
  try {
    // Примагничивание остановок к рельсам через Turf.js (СТРОГО ОДИН РАЗ при первой загрузке)
    window.snapPointsToRails = function() {
      try {
        if (typeof turf === 'undefined' || !window.routes || window.routes.length === 0 || !window.points || window.points.length === 0) return;

        window.points.forEach(pt => {
          if (pt._fixed_lat === undefined || pt._fixed_lon === undefined) {
            const lat = pt.original_lat !== undefined ? pt.original_lat : (pt.coords ? pt.coords[0] : pt.lat);
            const lon = pt.original_lon !== undefined ? pt.original_lon : (pt.coords ? pt.coords[1] : pt.lon);
            pt._fixed_lat = Number(lat);
            pt._fixed_lon = Number(lon);
            pt.coords = [pt._fixed_lat, pt._fixed_lon];
          }
        });

        const tramLines = window.routes
          .filter(r => r.type === 'tram' && r.poly_coordinates && r.poly_coordinates.length >= 2)
          .map(r => r.poly_coordinates.map(p => [p[1], p[0]])); // Turf ожидает [lon, lat]

        if (tramLines.length === 0) return;

        const multiLine = turf.multiLineString(tramLines);

        window.points.forEach(pt => {
          if (pt.type !== 'tram') return;
          if (pt._snapped) return; // Уже зафиксирован
          pt._snapped = true;

          try {
            const ptGeo = turf.point([pt._fixed_lon, pt._fixed_lat]);
            const snapped = turf.nearestPointOnLine(multiLine, ptGeo);
            if (snapped && snapped.geometry && snapped.geometry.coordinates) {
              const snappedCoords = snapped.geometry.coordinates;
              const distKm = turf.distance(ptGeo, snapped, { units: 'kilometers' });
              // Порог дистанции 25 метров: примагничивать к рельсам ТОЛЬКО если расстояние < 25м!
              if (distKm <= 0.025) {
                pt._fixed_lat = snappedCoords[1];
                pt._fixed_lon = snappedCoords[0];
                pt.coords = [pt._fixed_lat, pt._fixed_lon];
              }
            }
          } catch (err) {}
        });
      } catch (e) {
        console.warn('[stops_layer.js] snapPointsToRails warning:', e);
      }
    };

    window.fetchPoints = async function() {
      try {
        let res = await fetch('/map/api/stops').catch(() => null);
        if (!res || !res.ok) {
          res = await fetch('/api/stops').catch(() => null);
        }
        if (!res || !res.ok) {
          res = await fetch('/map/api/points').catch(() => null);
        }
        if (!res || !res.ok) {
          res = await fetch('/api/points').catch(() => null);
        }
        if (res && res.ok) {
          window.points = await res.json();
          // Фиксируем исходные координаты строго один раз с поддержкой lon/lng
          window.points.forEach(pt => {
            const rawLat = pt.original_lat !== undefined ? pt.original_lat : (pt.coords ? pt.coords[0] : pt.lat);
            const rawLon = pt.original_lon !== undefined ? pt.original_lon : (pt.coords ? pt.coords[1] : (pt.lon !== undefined ? pt.lon : pt.lng));
            const lat = parseFloat(rawLat);
            const lon = parseFloat(rawLon);

            if (!isNaN(lat) && !isNaN(lon)) {
              pt._fixed_lat = lat;
              pt._fixed_lon = lon;
              pt.coords = [lat, lon];
            }
          });
          window.snapPointsToRails();
        }
      } catch (e) {
        console.error('[stops_layer.js] Failed to fetch points:', e);
      }
      window.renderMarkers();
      if (typeof window.renderSidebarList === 'function') window.renderSidebarList();
      if (typeof window.updateCounter === 'function') window.updateCounter();
    };

    window.getFilteredPoints = function() {
      const search = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
      const points = window.points || [];
      const activeFilter = window.activeFilter || 'all';
      const selectedRouteId = window.selectedRouteId || 'all';
      const routes = window.routes || [];

      return points.filter(pt => {
        if (activeFilter !== 'all' && pt.type !== activeFilter) return false;
        if (selectedRouteId !== 'all') {
          const selectedRoute = routes.find(r => r.id === selectedRouteId);
          if (selectedRoute) {
            const num = selectedRoute.number;
            const routesList = (pt.route || '').split(',').map(s => s.trim());
            if (!routesList.includes(num)) return false;
          }
        }
        if (search) {
          return (pt.name || '').toLowerCase().includes(search) ||
                 (pt.route || '').toLowerCase().includes(search) ||
                 (pt.desc || '').toLowerCase().includes(search);
        }
        return true;
      });
    };

    window.renderMarkers = function() {
      try {
        const isRouteSelected = (window.selectedRouteId && window.selectedRouteId !== 'all');
        if (window.markersCluster) window.markersCluster.clearLayers();
        if (window.stopsGroup) window.stopsGroup.clearLayers();
        // При выборе маршрута маркеры добавляются напрямую в stopsGroup без кластеризации
        if (!isRouteSelected && window.stopsGroup && window.markersCluster) {
          window.stopsGroup.addLayer(window.markersCluster);
        }
        window.markerInstances = {};

        const filtered = window.getFilteredPoints();
        const incidents = window.incidents || [];
        const TYPE_META = window.TYPE_META;

        filtered.forEach(stop => {
          const lat = parseFloat(stop._fixed_lat !== undefined ? stop._fixed_lat : (stop.lat !== undefined ? stop.lat : (stop.coords ? stop.coords[0] : undefined)));
          const lon = parseFloat(stop._fixed_lon !== undefined ? stop._fixed_lon : (stop.lon !== undefined ? stop.lon : (stop.lng !== undefined ? stop.lng : (stop.coords ? stop.coords[1] : undefined))));

          // ЖЕЛЕЗНАЯ ЗАЩИТА: если координаты кривые — пропускаем, но НЕ роняем карту!
          if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
            console.warn("Пропущена остановка с невалидными координатами:", stop);
            return;
          }

          const meta = TYPE_META[stop.type] || TYPE_META.tram;
          const color = stop.type === 'tram' ? '#3b82f6' : (stop.color || meta.defaultColor);
          const isClosure = stop.type === 'closure';

          // Проверка: отключена ли остановка текущими инцидентами или статусом
          const isDisabled = stop.status === 'closed' || incidents.some(inc => {
            if (inc.status !== 'ACTIVE') return false;
            let dStops = inc.disabled_stop_ids;
            if (typeof dStops === 'string') {
              try { dStops = JSON.parse(dStops); } catch (e) { dStops = []; }
            }
            return Array.isArray(dStops) && (dStops.includes(stop.id) || dStops.includes(String(stop.id)) || dStops.includes(stop.name));
          });

          let marker;
          const isDraggable = !!window.isEditMode;

          if (isDraggable) {
            // В режиме правки делаем маркер перетаскиваемым L.marker с рамкой amber
            const dragIconHtml = `
              <div class="w-6 h-6 rounded-full border-2 border-white shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing ring-2 ring-amber-400 select-none text-[11px]" style="background-color: ${isDisabled ? '#ef4444' : (stop.type === 'trolley' ? '#0d9488' : '#2563eb')}; color: #ffffff;">
                ${isDisabled ? '⛔' : (stop.type === 'trolley' ? '🚎' : '🚊')}
              </div>
            `;
            const dragIcon = L.divIcon({
              className: 'custom-drag-stop-pin',
              html: dragIconHtml,
              iconSize: [24, 24],
              iconAnchor: [12, 12],
              popupAnchor: [0, -14]
            });
            marker = L.marker([lat, lon], { icon: dragIcon, draggable: true });
            marker.on('dragend', async (ev) => {
              const newPos = ev.target.getLatLng();
              if (typeof window.handleStopDragEnd === 'function') {
                await window.handleStopDragEnd(stop, newPos);
                return;
              }
              stop._fixed_lat = newPos.lat;
              stop._fixed_lon = newPos.lng;
              stop.lat = newPos.lat;
              stop.lng = newPos.lng;
              stop.coords = [newPos.lat, newPos.lng];

              try {
                const token = localStorage.getItem('uet_admin_token') || '';
                const res = await fetch('/map/api/stops/update', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                  },
                  body: JSON.stringify({
                    stops: [{ id: stop.id, name: stop.name, lat: newPos.lat, lng: newPos.lng }]
                  })
                });
                if (res.ok) {
                  window.showToast(`Координаты «${stop.name}» сохранены в БД`);
                  if (typeof window.renderRoutes === 'function') window.renderRoutes();
                } else {
                  window.showToast('Ошибка сохранения координат');
                }
              } catch (e) {
                console.error('Failed to update stop coords:', e);
              }
            });
          } else if (isClosure || isDisabled) {
            const iconHtml = `
              <div class="w-6 h-6 rounded-full border-2 border-white shadow-lg flex items-center justify-center cursor-pointer select-none text-[11px] bg-rose-600 text-white animate-pulse">
                ⛔
              </div>
            `;
            const customIcon = L.divIcon({
              className: 'uet-marker-closure',
              html: iconHtml,
              iconSize: [24, 24],
              iconAnchor: [12, 12],
              popupAnchor: [0, -14]
            });
            marker = L.marker([lat, lon], { icon: customIcon, draggable: false });
          } else {
            // Если выбран конкретный маршрут — делаем аккуратные точечные L.circleMarker (радиус 5px с белой обводкой)
            if (isRouteSelected) {
              const circleColor = stop.type === 'trolley' ? '#0d9488' : '#2563eb';
              marker = L.circleMarker([lat, lon], {
                radius: 5,
                fillColor: circleColor,
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 1
              });
            } else {
              // В общем виде — значки 20x20px
              const isTrolley = stop.type === 'trolley';
              const bgColor = isTrolley ? '#0d9488' : '#2563eb';
              const iconChar = isTrolley ? '🚎' : '🚊';

              const iconHtml = `
                <div class="w-5 h-5 rounded-full border-2 border-white shadow-md flex items-center justify-center cursor-pointer select-none text-[9px] transition-transform duration-150 hover:scale-125" style="background-color: ${bgColor}; color: #ffffff;">
                  ${iconChar}
                </div>
              `;
              const stopIcon = L.divIcon({
                className: 'uet-stop-icon',
                html: iconHtml,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
                popupAnchor: [0, -12]
              });
              marker = L.marker([lat, lon], { icon: stopIcon, draggable: false });
            }
          }

          // Название остановки всплывает при наведении курсора
          marker.bindTooltip(stop.name || "Остановка", {
            permanent: false,
            direction: 'top',
            offset: [0, -10],
            className: 'bg-slate-900 text-white text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-700 shadow-xl'
          });

          const popupContent = `
            <div class="space-y-1.5 p-1 min-w-[200px]">
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-lg flex items-center justify-center text-xs" style="background:${isDisabled ? '#E5393525' : color + '25'}; color:${isDisabled ? '#E53935' : color}">${isDisabled ? '⛔' : meta.icon}</span>
                <div>
                  <h4 class="text-xs font-bold ${isDisabled ? 'text-rose-400 line-through' : 'text-white'}">${window.escapeHtml(stop.name)}</h4>
                  <span class="text-[10px] ${isDisabled ? 'text-rose-400 font-bold' : 'text-slate-400 font-medium'}">${isDisabled ? 'ВРЕМЕННО ЗАКРЫТА' : meta.label}</span>
                </div>
              </div>

              ${isDisabled ? `
                <div class="p-2 rounded-xl bg-rose-500/20 border border-rose-500/40 text-[11px] text-rose-200">
                  ⚠️ Остановка временно исключена из движения из-за перекрытия путей.
                </div>
              ` : ''}

              ${stop.route ? `
                <div class="pt-1">
                  <span class="text-[10px] text-slate-400 block mb-1">Маршруты на этой остановке:</span>
                  <div class="flex flex-wrap gap-1">
                    ${stop.route.split(',').map(rNum => `<span class="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[11px] font-mono font-bold">№ ${window.escapeHtml(rNum.trim())}</span>`).join('')}
                  </div>
                </div>` : '<div class="text-[10px] text-slate-500 italic">Маршруты уточняются</div>'}

              ${stop.desc ? `<p class="text-[11px] text-slate-300 leading-tight pt-1 border-t border-slate-800">${window.escapeHtml(stop.desc)}</p>` : ''}

              <!-- ШАГ 7.1: Расчетное время прибытия вагона (ETA) для всех пассажиров -->
              <div class="pt-1.5 border-t border-slate-800 space-y-1.5">
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-slate-400">Ближайший рейс (ETA):</span>
                  <span class="font-mono text-emerald-400 font-bold">~${isDisabled ? 'Движение закрыто' : '4-7 мин'}</span>
                </div>
                ${(window.isAdminAuthenticated || document.getElementById('btn-admin-auth')) ? `
                <div class="flex items-center gap-1.5 pt-0.5">
                  <button type="button" onclick="if(typeof window.openEditModal==='function')window.openEditModal('${stop.id}')" class="flex-1 py-1 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-[10px] font-semibold transition-all border border-slate-700 text-center">
                    ✏️ Изменить
                  </button>
                  <button type="button" onclick="if(typeof window.quickClosureFromStop==='function'){window.quickClosureFromStop('${stop.id}','${window.escapeHtml(stop.name)}')}else if(typeof window.openIncidentsManagerModal==='function'){window.openIncidentsManagerModal()}" class="flex-1 py-1 px-2 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-[10px] font-semibold transition-all text-center">
                    ⛔ Перекрыть отсюда
                  </button>
                </div>
                ` : ''}
              </div>
            </div>
          `;

          marker.bindPopup(popupContent);

              marker.on('click', () => {
                const incidentsModal = document.getElementById('incidents-manager-modal');
                const isIncidentsModalOpen = incidentsModal && !incidentsModal.classList.contains('hidden');

                if (isIncidentsModalOpen) {
                  if (typeof window.onStopClicked === 'function') {
                    window.onStopClicked(stop);
                  }
                  return;
                }

                // В админке (или при режиме правки Drag) клик открывает модалку редактирования остановки
                if (typeof window.openEditModal === 'function' && (window.isAdminAuthenticated || document.getElementById('btn-admin-auth'))) {
                  window.openEditModal(stop.id);
                }
              });

              window.markerInstances[stop.id] = marker;
              if (isRouteSelected) {
                if (window.stopsGroup) window.stopsGroup.addLayer(marker);
              } else {
                if (window.markersCluster) window.markersCluster.addLayer(marker);
              }
            });
          } catch (err) {
            console.error('[stops_layer.js] Error in renderMarkers:', err);
          }
        };
  } catch (globalErr) {
    console.error('Global error in stops_layer.js:', globalErr);
  }
})();
