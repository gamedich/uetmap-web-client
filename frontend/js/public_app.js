// Ignore historical protection placeholders in both network and offline track data.
function onlyTransportLines(geo) {
  if (!geo || !Array.isArray(geo.features)) return geo;
  return {...geo, features: geo.features.filter(f => ['LineString', 'MultiLineString'].includes(f?.geometry?.type))};
}

// ========================================================
    // ЕДИНЫЙ ЧИСТЫЙ СКРИПТ КАРТЫ ЭЛЕКТРОТРАНСПОРТА (UETMAP)
    // Без MarkerCluster, без snap, без соединения прямыми линиями
    // ========================================================
    let map = null;
    let currentType = 'tram'; // 'tram' | 'trolleybus'
    let tracksLayer = null;
    let stopsLayer = null;
    let highlightStopsLayer = null;

    let allRoutes = [];
    let currentRouteId = 'all';
    let currentStopsData = [];
    let activeClosures = [];
    let blockedLayer = null;
    let isDarkTheme = true;
    let isSidebarCollapsed = window.innerWidth < 640;

    // 1. Инициализация Leaflet карты
    function initMap() {
      const ulyanovskBounds = L.latLngBounds(
        L.latLng(54.1500, 48.1500), // Юго-западная граница (пригород/Киндяковка/Баратаевка)
        L.latLng(54.4800, 48.7000)  // Северо-восточная граница (Поливно/Новый Город/Архангельское)
      );

      map = L.map('map', {
        attributionControl: false,
        preferCanvas: true,
        zoomControl: false,
        maxBounds: ulyanovskBounds,
        maxBoundsViscosity: 1.0,
        minZoom: 11,
        maxZoom: 18
      }).setView([54.3188, 48.3977], 12);

      map.setMaxBounds(ulyanovskBounds);

      L.control.zoom({ position: 'bottomright' }).addTo(map);

      // Кэширующий локальный слой тайлов (работает офлайн и без внешних лимитов)
      const tileUrl = window.location.pathname.startsWith('/map') ? '/map/tiles/{z}/{x}/{y}.png?masked=20261113' : '/tiles/{z}/{x}/{y}.png?masked=20261113';
      L.tileLayer(tileUrl, {
        maxZoom: 18,
        minZoom: 11
      }).addTo(map);

      // Pane для затемнения области за пределами города (виньетка)
      map.createPane('cityMaskPane');
      map.getPane('cityMaskPane').style.zIndex = 300;

      // Pane для оформления подложки карты: выше тайлов (200), ниже путей и остановок (400)
      map.createPane('backdropPane');
      map.getPane('backdropPane').style.zIndex = 350;

      // Маска затемнения за пределами Ульяновска
      applyCityOutskirtsMask();

      // Загрузка масок подложки
      loadBackdropMasks();

      // Слой онлайн-транспорта (линейные вагоны и троллейбусы для пассажиров)
      window.passengerVehiclesLayer = L.layerGroup().addTo(map);

      setTimeout(() => { if (map) map.invalidateSize(); }, 200);
      window.addEventListener('resize', () => { if (map) map.invalidateSize(); });
    }

    // Затемнение области за пределами агломерации города Ульяновска
    function applyCityOutskirtsMask() {
      const worldOuter = [
        [-85, -180],
        [-85, 180],
        [85, 180],
        [85, -180]
      ];
      const ulyanovskHole = [
        [54.4800, 48.1500],
        [54.4800, 48.7000],
        [54.1500, 48.7000],
        [54.1500, 48.1500]
      ];
      L.polygon([worldOuter, ulyanovskHole], {
        pane: 'cityMaskPane',
        fillColor: "#0b0f19",
        fillOpacity: 0.85,
        color: "transparent",
        interactive: false
      }).addTo(map);
    }

    // Универсальный хелпер запросов к API с авто-определением префикса (/map/api или /api)
    async function apiFetch(endpoint) {
      const clean = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
      const candidates = [];
      if (window.location.pathname.startsWith('/map')) {
        candidates.push('/map' + clean);
        candidates.push(clean);
      } else {
        candidates.push(clean);
        candidates.push('/map' + clean);
      }

      let lastErr = null;
      for (const url of candidates) {
        try {
          const res = await fetch(url);
          if (res.ok) return res;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('Failed to fetch from candidate URLs: ' + candidates.join(', '));
    }

    // Загрузка масок оформления подложки карты
    let backdropMasksLayer = null;
    async function loadBackdropMasks() {
      try {
        const res = await apiFetch('/data/geo/map_backdrop_masks.geojson');
        if (!res.ok) return;
        const geoData = await res.json();
        if (backdropMasksLayer && map.hasLayer(backdropMasksLayer)) {
          map.removeLayer(backdropMasksLayer);
        }
        backdropMasksLayer = L.geoJSON(geoData, {
          pane: 'backdropPane',
          style: {
            fillColor: "#1e293b",       // Тёмный серо-синий тон подложки интерфейса
            fillOpacity: 1.0,           // 100% глухая непрозрачность — подложка не просвечивает
            stroke: false,              // Никаких рамок по краям
            interactive: false          // Отключить клики, всплывающие подсказки и ховеры
          }
        }).addTo(map);
      } catch (e) {
        console.warn('Backdrop masks layer failed to load:', e);
      }
    }

    // Индекс соответствия остановок и проходящих маршрутов
    let stopToRoutesMap = new Map();

    function buildStopRoutesIndex() {
      stopToRoutesMap.clear();
      if (!Array.isArray(allRoutes) || allRoutes.length === 0) return;

      allRoutes.forEach(r => {
        const routeInfo = {
          route_id: String(r.route_id),
          uniqueId: `${r.transport_type === 'tram' ? 'tram' : 'trolley'}_${r.route_id}`,
          title: r.title || `Маршрут № ${r.route_id}`,
          transport_type: r.transport_type || 'tram',
          has_detour: Boolean(r.has_detour || r.is_detour_active),
          is_detour_active: Boolean(r.is_detour_active),
          detour_reason: r.detour_reason || r.detour_info?.reason || ''
        };

        const stopsList = Array.isArray(r.stops) ? r.stops : [];
        stopsList.forEach(s => {
          let rawId = '';
          let stopName = '';
          if (typeof s === 'object' && s !== null) {
            rawId = String(s.stop_id ?? s.id ?? '');
            stopName = s.name ? String(s.name).trim() : '';
          } else {
            rawId = String(s ?? '');
          }

          const keysToAdd = new Set();
          if (rawId) {
            keysToAdd.add(rawId);
            keysToAdd.add(rawId.replace(/^node\//, ''));
            keysToAdd.add(`node/${rawId.replace(/^node\//, '')}`);
          }
          if (stopName) {
            keysToAdd.add(stopName.toLowerCase());
          }

          keysToAdd.forEach(k => {
            if (!stopToRoutesMap.has(k)) {
              stopToRoutesMap.set(k, []);
            }
            const existing = stopToRoutesMap.get(k);
            if (!existing.some(item => item.uniqueId === routeInfo.uniqueId)) {
              existing.push(routeInfo);
            }
          });
        });
      });

      // Дополнительно связываем названия остановок из currentStopsData
      if (Array.isArray(currentStopsData)) {
        currentStopsData.forEach(feat => {
          const p = feat.properties || {};
          const fName = (p.name || '').trim();
          if (!fName) return;

          const fIds = [feat.id, p['@id'], p.id].filter(Boolean).map(String);
          let foundRoutes = [];
          for (const id of fIds) {
            const list = stopToRoutesMap.get(id) || stopToRoutesMap.get(id.replace(/^node\//, ''));
            if (list && list.length) {
              foundRoutes = list;
              break;
            }
          }

          if (foundRoutes.length > 0) {
            const nameKey = fName.toLowerCase();
            if (!stopToRoutesMap.has(nameKey)) {
              stopToRoutesMap.set(nameKey, []);
            }
            const nameRoutes = stopToRoutesMap.get(nameKey);
            foundRoutes.forEach(r => {
              if (!nameRoutes.some(item => item.uniqueId === r.uniqueId)) {
                nameRoutes.push(r);
              }
            });
          }
        });
      }
    }

    function getPassingRoutesForStop(feature, name) {
      const f = feature || {};
      const p = f.properties || {};

      // Сбор всех идентификаторов остановки
      const stopIds = new Set();
      if (f.id) {
        const s = String(f.id).trim();
        stopIds.add(s);
        stopIds.add(s.replace(/^node\//, ''));
        stopIds.add('node/' + s.replace(/^node\//, ''));
      }
      ['@id', 'id', 'stop_id', 'osm_id'].forEach(k => {
        if (p[k]) {
          const s = String(p[k]).trim();
          stopIds.add(s);
          stopIds.add(s.replace(/^node\//, ''));
          stopIds.add('node/' + s.replace(/^node\//, ''));
        }
      });
      const stopName = (name || p.name || '').trim().toLowerCase();

      // 1. Проверяем поле routes у самой остановки
      const stopRoutes = new Set();
      const rawRoutes = p.routes || f.routes || (typeof f.route === 'string' ? f.route : null);
      if (rawRoutes) {
        const arr = Array.isArray(rawRoutes) ? rawRoutes : String(rawRoutes).split(/[,\s]+/);
        arr.forEach(r => {
          const clean = String(r).trim();
          if (clean) stopRoutes.add(clean);
        });
      }

      // 2. Сканируем загруженные маршруты на лету
      // allRoutes содержит список всех загруженных маршрутов сети
      const routesToScan = Array.isArray(allRoutes) ? allRoutes : [];

      routesToScan.forEach(r => {
        const routeNum = String(r.route_id || '').trim();
        if (!routeNum) return;

        let hasStop = false;

        // Проверяем r.stops
        if (Array.isArray(r.stops)) {
          for (const s of r.stops) {
            if (s == null) continue;
            let sid = '';
            let sName = '';
            if (typeof s === 'object') {
              // Исключаем опорные точки
              if (s.is_visible === false || s.is_waypoint === true || s.properties?.is_waypoint === true) {
                continue;
              }
              sid = String(s.stop_id ?? s.id ?? '').trim();
              sName = String(s.name ?? '').trim().toLowerCase();
            } else {
              sid = String(s).trim();
            }
            if (!sid || sid.startsWith('wp_')) continue;

            const cleanSid = sid.replace(/^node\//, '');
            if (stopIds.has(sid) || stopIds.has(cleanSid) || (stopName && sName && sName === stopName)) {
              hasStop = true;
              break;
            }
          }
        }

        // Если в r есть directions (детальные направления)
        if (!hasStop && r.directions && typeof r.directions === 'object') {
          for (const dir of Object.values(r.directions)) {
            if (!dir) continue;
            const dirStops = [
              ...(Array.isArray(dir.stops) ? dir.stops : []),
              ...(Boolean(r.has_detour || r.is_detour_active) && Array.isArray(dir.detour_stops) ? dir.detour_stops : [])
            ];
            for (const s of dirStops) {
              if (s == null) continue;
              let sid = '';
              let sName = '';
              if (typeof s === 'object') {
                if (s.is_visible === false || s.is_waypoint === true || s.properties?.is_waypoint === true) {
                  continue;
                }
                sid = String(s.stop_id ?? s.id ?? '').trim();
                sName = String(s.name ?? '').trim().toLowerCase();
              } else {
                sid = String(s).trim();
              }
              if (!sid || sid.startsWith('wp_')) continue;

              const cleanSid = sid.replace(/^node\//, '');
              if (stopIds.has(sid) || stopIds.has(cleanSid) || (stopName && sName && sName === stopName)) {
                hasStop = true;
                break;
              }
            }
            if (hasStop) break;
          }
        }

        // Если остановка входит в маршрут — добавляем номер
        if (hasStop) {
          stopRoutes.add(routeNum);
        }
      });

      // Также проверяем activeSelectedRouteData (если открыт детальный маршрут)
      if (activeSelectedRouteData && activeSelectedRouteData.route_id) {
        const routeNum = String(activeSelectedRouteData.route_id).trim();
        const dirs = activeSelectedRouteData.directions || {};
        for (const dir of Object.values(dirs)) {
          if (!dir) continue;
          const dirStops = [
            ...(Array.isArray(dir.stops) ? dir.stops : []),
            ...(Boolean(activeSelectedRouteData.has_detour || activeSelectedRouteData.is_detour_active) && Array.isArray(dir.detour_stops) ? dir.detour_stops : [])
          ];
          for (const s of dirStops) {
            if (s == null) continue;
            let sid = '';
            let sName = '';
            if (typeof s === 'object') {
              if (s.is_visible === false || s.is_waypoint === true || s.properties?.is_waypoint === true) continue;
              sid = String(s.stop_id ?? s.id ?? '').trim();
              sName = String(s.name ?? '').trim().toLowerCase();
            } else {
              sid = String(s).trim();
            }
            if (!sid || sid.startsWith('wp_')) continue;
            const cleanSid = sid.replace(/^node\//, '');
            if (stopIds.has(sid) || stopIds.has(cleanSid) || (stopName && sName && sName === stopName)) {
              stopRoutes.add(routeNum);
              break;
            }
          }
        }
      }

      // Преобразуем найденные номера маршрутов в объекты с метаданными маршрута
      const results = [];
      const addedUnique = new Set();

      stopRoutes.forEach(rNum => {
        // Ищем метаданные маршрута в allRoutes
        const matchedRoute = routesToScan.find(r => String(r.route_id).trim() === rNum);
        const tType = matchedRoute?.transport_type || (p.transport_type === 'trolleybus' || p.highway === 'bus_stop' ? 'trolleybus' : 'tram');
        const uniqueId = matchedRoute ? `${matchedRoute.transport_type === 'tram' ? 'tram' : 'trolley'}_${matchedRoute.route_id}` : `${tType === 'tram' ? 'tram' : 'trolley'}_${rNum}`;
        const hasDetour = Boolean(matchedRoute?.has_detour || matchedRoute?.is_detour_active);

        if (!addedUnique.has(uniqueId)) {
          addedUnique.add(uniqueId);
          results.push({
            route_id: rNum,
            uniqueId: uniqueId,
            transport_type: tType,
            title: matchedRoute?.title || `${tType === 'tram' ? 'Трамвай' : 'Троллейбус'} № ${rNum}`,
            has_detour: hasDetour,
            is_detour_active: hasDetour,
            detour_reason: matchedRoute?.detour_reason || matchedRoute?.detour_info?.reason || ''
          });
        }
      });

      // Естественная сортировка по номерам (1, 4, 10, 22, 22к, 70, 107)
      results.sort((a, b) => {
        const parseNum = s => {
          const m = String(s).trim().match(/^(\d+)(.*)/);
          return m ? [parseInt(m[1], 10), m[2]] : [99999, String(s)];
        };
        const [numA, sfxA] = parseNum(a.route_id);
        const [numB, sfxB] = parseNum(b.route_id);
        if (numA !== numB) return numA - numB;
        return a.route_id.localeCompare(b.route_id);
      });

      return results;
    }

    function isStopUnderDetour(feature, name, passingRoutes) {
      if (Array.isArray(passingRoutes) && passingRoutes.some(r => r.has_detour || r.is_detour_active)) {
        return true;
      }
      if (Array.isArray(activeClosures)) {
        const stopName = (name || '').toLowerCase().trim();
        const stopId = String(feature?.id || '').toLowerCase();
        for (const c of activeClosures) {
          const closedStops = c.closed_stops || c.bypassed_stops || [];
          if (closedStops.some(cs => {
            const csName = (typeof cs === 'string' ? cs : cs.name || cs.id || '').toLowerCase().trim();
            return csName && (csName === stopName || csName === stopId);
          })) {
            return true;
          }
        }
      }
      return false;
    }

    function renderTracksLayer(tracksGeo, trackColor) {
      if (tracksLayer && map.hasLayer(tracksLayer)) {
        map.removeLayer(tracksLayer);
      }
      tracksLayer = L.geoJSON(tracksGeo, {
        style: {
          color: trackColor,
          weight: 3.5,
          opacity: 0.65,
          lineCap: 'round',
          lineJoin: 'round'
        }
      }).addTo(map);
      try {
        if (tracksLayer.getBounds && tracksLayer.getBounds().isValid() && currentRouteId === 'all') {
          map.fitBounds(tracksLayer.getBounds(), { padding: [20, 20], maxZoom: 14 });
        }
      } catch (e) {}
    }

    function renderStopsLayer(stopsGeo) {
      if (stopsLayer && map.hasLayer(stopsLayer)) {
        map.removeLayer(stopsLayer);
      }
      currentStopsData = stopsGeo.features || [];
      buildStopRoutesIndex();

      stopsLayer = L.geoJSON(stopsGeo, {
        pointToLayer: (feature, latlng) => {
          const hitboxMarker = L.circleMarker(latlng, {
            radius: 20,
            stroke: false,
            fillColor: '#000000',
            fillOpacity: 0.0001,
            interactive: true
          });

          const visualMarker = L.circleMarker(latlng, {
            radius: 8,
            fillColor: '#1d4ed8',
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 1,
            interactive: true
          });

          const name = feature.properties?.name || 'Остановка';

          function onHover() {
            if (visualMarker._isMasked) return;
            visualMarker.setRadius(11);
            visualMarker.setStyle({ fillColor: '#2563eb' });
          }
          function onLeave() {
            if (visualMarker._isMasked) return;
            visualMarker.setRadius(8);
            visualMarker.setStyle({ fillColor: '#1d4ed8' });
          }

          hitboxMarker.on('mouseover', onHover);
          hitboxMarker.on('mouseout', onLeave);
          visualMarker.on('mouseover', onHover);
          visualMarker.on('mouseout', onLeave);

          function onClick(e) {
            if (visualMarker._isMasked) return;
            if (e) L.DomEvent.stopPropagation(e);
            focusOnStop(name, [latlng.lat, latlng.lng], feature);
          }
          hitboxMarker.on('click', onClick);
          visualMarker.on('click', onClick);

          visualMarker.bindTooltip(`<b>${escapeHtml(name)}</b>`, {
            direction: 'top',
            offset: [0, -10],
            className: 'bg-slate-900 text-white text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-700 shadow-xl'
          });

          const grp = L.featureGroup([hitboxMarker, visualMarker]);
          grp._visualMarker = visualMarker;
          grp._hitboxMarker = hitboxMarker;
          grp._feature = feature;
          grp._stopId = String(feature.id || feature.properties?.['@id'] || feature.properties?.id || '');
          return grp;
        }
      }).addTo(map);

      renderStopsList(currentStopsData);
    }

    function renderRoutesUI(routesList) {
      if (!Array.isArray(routesList)) return;
      allRoutes = routesList;
      const tramsGroup = document.getElementById('opt-trams');
      const trolleysGroup = document.getElementById('opt-trolleys');

      if (tramsGroup && trolleysGroup) {
        tramsGroup.innerHTML = '';
        trolleysGroup.innerHTML = '';
        allRoutes.forEach(r => {
          const uniqueId = `${r.transport_type === 'tram' ? 'tram' : 'trolley'}_${r.route_id}`;
          const opt = document.createElement('option');
          opt.value = uniqueId;
          opt.textContent = `${r.title} ${r.has_detour ? '(Объезд)' : ''}`;
          if (r.transport_type === 'tram') {
            tramsGroup.appendChild(opt);
          } else {
            trolleysGroup.appendChild(opt);
          }
        });
      }

      renderRoutePills();
      renderRoutesList(allRoutes);
      buildStopRoutesIndex();
      updateCompactSheetBar();
    }

    // 2. Загрузка инфраструктуры: фоновые рельсы/провода и точечные остановки (Offline-First)
    async function loadInfrastructure(type) {
      if (highlightStopsLayer && map.hasLayer(highlightStopsLayer)) {
        map.removeLayer(highlightStopsLayer);
      }
      const trackColor = (type === 'tram') ? '#38bdf8' : '#34d399';

      // 1) МГНОВЕННО читаем из IndexedDB до любого сетевого запроса
      if (window.UETOfflineDB) {
        try {
          const [cachedTracks, cachedStops] = await Promise.all([
            window.UETOfflineDB.getTracks(type),
            window.UETOfflineDB.getStops(type)
          ]);
          if (cachedTracks) {
            window.publicTracksGeo = onlyTransportLines(cachedTracks);
            renderTracksLayer(window.publicTracksGeo, trackColor);
          }
          if (cachedStops && Array.isArray(cachedStops.features) && cachedStops.features.length > 0) {
            renderStopsLayer(cachedStops);
          }
        } catch (e) {
          console.warn('IndexedDB initial read error:', e);
        }
      }

      // 2) Запрашиваем актуальные данные из сети и СРАЗУ сохраняем в IndexedDB
      try {
        const [resTracks, resStops] = await Promise.all([
          apiFetch(`/api/geo/tracks?type=${type}`).catch(() => null),
          apiFetch(`/api/geo/stops?type=${type}`).catch(() => null)
        ]);

        if (resTracks && resTracks.ok) {
          const tracksGeo = onlyTransportLines(await resTracks.json());
          window.publicTracksGeo = tracksGeo;
          renderTracksLayer(tracksGeo, trackColor);
          if (window.UETOfflineDB) await window.UETOfflineDB.saveTracks(type, tracksGeo);
        }

        if (resStops && resStops.ok) {
          const stopsGeo = await resStops.json();
          renderStopsLayer(stopsGeo);
          if (window.UETOfflineDB) await window.UETOfflineDB.saveStops(type, stopsGeo);
        }
      } catch (e) {
        console.warn('Network infrastructure load error (offline fallback active):', e);
      }
    }

    function syncPublicStopsLayerMask(waypoints) {
      if (!stopsLayer) return;
      const maskedIds = new Set();
      const maskedCoords = [];

      if (Array.isArray(waypoints) && waypoints.length > 0) {
        waypoints.forEach(st => {
          const sid = getStopId(st);
          if (sid) maskedIds.add(String(sid));
          let latlng = null;
          if (Array.isArray(st.coords) && st.coords.length >= 2) latlng = [Number(st.coords[0]), Number(st.coords[1])];
          else if (Array.isArray(st.coordinates) && st.coordinates.length >= 2) latlng = [Number(st.coordinates[1]), Number(st.coordinates[0])];
          if (latlng) maskedCoords.push(latlng);
        });
      }

      stopsLayer.eachLayer(layer => {
        const visual = layer._visualMarker || (layer.setStyle ? layer : null);
        const hitbox = layer._hitboxMarker;
        const sid = layer._stopId || (layer.feature ? String(layer.feature.id || layer.feature.properties?.['@id'] || layer.feature.properties?.id || '') : null);

        let shouldMask = false;
        if (sid && maskedIds.has(sid)) {
          shouldMask = true;
        } else if (layer.getLatLng) {
          const lll = layer.getLatLng();
          if (maskedCoords.some(c => map.distance([c[0], c[1]], lll) < 15)) {
            shouldMask = true;
          }
        } else if (layer.getBounds) {
          const center = layer.getBounds().getCenter();
          if (maskedCoords.some(c => map.distance([c[0], c[1]], center) < 15)) {
            shouldMask = true;
          }
        }

        if (visual && visual.setStyle) {
          visual._isMasked = shouldMask;
          if (shouldMask) {
            visual.setStyle({ opacity: 0, fillOpacity: 0 });
            if (hitbox && hitbox.setStyle) hitbox.setStyle({ interactive: false });
            if (layer.closeTooltip) layer.closeTooltip();
            if (visual.closeTooltip) visual.closeTooltip();
          } else {
            visual.setStyle({
              radius: 8,
              fillColor: '#1d4ed8',
              color: '#ffffff',
              weight: 2,
              opacity: 1,
              fillOpacity: 1
            });
            if (hitbox && hitbox.setStyle) hitbox.setStyle({ interactive: true });
          }
        }
      });
    }

    // 3. Загрузка списка маршрутов (Offline-First)
    async function loadRoutes() {
      // 1) Мгновенно из IndexedDB до сетевого запроса
      if (window.UETOfflineDB) {
        try {
          const cachedRoutes = await window.UETOfflineDB.getRoutes(currentType);
          if (Array.isArray(cachedRoutes) && cachedRoutes.length > 0) {
            renderRoutesUI(cachedRoutes);
          }
        } catch (e) {}
      }

      // 2) Запрашиваем из сети и СРАЗУ сохраняем в IndexedDB
      try {
        const res = await apiFetch(`/api/geo/routes?type=${currentType}`);
        if (res && res.ok) {
          const rList = await res.json();
          renderRoutesUI(rList);
          if (window.UETOfflineDB) await window.UETOfflineDB.saveRoutes(currentType, rList);
        }
      } catch (e) {
        console.warn('Network routes load error (offline fallback active):', e);
      }
    }

    // Хелпер: проверить, затронут ли маршрут активным перекрытием
    function getRouteClosureInfo(routeId, transportType) {
      const rStr = String(routeId);
      for (const c of activeClosures) {
        if (c.transport_type && c.transport_type !== transportType) continue;
        const affected = (c.affected_routes || []).map(String);
        if (affected.includes(rStr)) {
          const detour = c.detours?.[rStr] || {};
          return {
            isAffected: true,
            status: detour.status || 'modified',
            description: detour.description || c.passenger_alert?.message || 'Движение временно изменено',
            alert: c.passenger_alert || {}
          };
        }
      }
      return null;
    }

    // Рендер верхних пилюль быстрых маршрутов
    function renderRoutePills() {
      const bar = document.getElementById('route-pills-bar');
      if (!bar) return;
      bar.innerHTML = `
        <button type="button" onclick="selectRoute('all')" id="pill-all" class="route-pill-btn pointer-events-auto ${currentRouteId === 'all' ? 'active' : ''} px-3 py-1.5 rounded-full text-xs font-bold bg-slate-900/90 text-white border border-slate-700/80 shadow-lg backdrop-blur-md hover:bg-slate-800 shrink-0">
          Все пути
        </button>
      `;

      allRoutes.forEach(r => {
        if (r.transport_type !== currentType) return;
        const uniqueId = `${r.transport_type === 'tram' ? 'tram' : 'trolley'}_${r.route_id}`;
        const clsInfo = getRouteClosureInfo(r.route_id, r.transport_type);
        const hasWarning = !!clsInfo || r.has_detour;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = `pill-${uniqueId}`;
        btn.className = `route-pill-btn pointer-events-auto ${currentRouteId === uniqueId ? 'active' : ''} px-2.5 py-1.5 rounded-full text-xs font-bold bg-slate-900/90 text-slate-200 border ${hasWarning ? 'border-amber-400/80 text-amber-300' : 'border-slate-700/80'} shadow-lg backdrop-blur-md hover:bg-slate-800 flex items-center gap-1 shrink-0`;
        const prefix = (r.transport_type === 'tram') ? 'Т' : 'Тр';
        btn.innerHTML = `<span>${prefix}${r.route_id}</span>${hasWarning ? '<span class="text-[11px]" title="Маршрут изменен">⚠️</span>' : ''}`;
        btn.onclick = () => selectRoute(uniqueId);
        bar.appendChild(btn);
      });
    }

    // Рендер каталога маршрутов в сайдбаре (Impeccable: плоский список с hairline-разделителями, без карточек в карточках)
    function renderRoutesList(routes) {
      const container = document.getElementById('routes-catalog-list');
      if (!container) return;
      container.innerHTML = '';

      if (routes.length === 0) {
        container.innerHTML = '<div class="text-center py-6 text-xs text-slate-400">Маршруты не найдены</div>';
        return;
      }

      routes.forEach(r => {
        const uniqueId = `${r.transport_type === 'tram' ? 'tram' : 'trolley'}_${r.route_id}`;
        const clsInfo = getRouteClosureInfo(r.route_id, r.transport_type);
        const hasWarning = !!clsInfo || r.has_detour;
        const row = document.createElement('div');
        const isActive = (currentRouteId === uniqueId);

        // Impeccable: плоский ряд без объемной внутренней карточки, четкий акцент состояния
        row.className = `route-catalog-row min-h-[44px] px-3 py-2.5 rounded-xl border border-transparent transition-colors cursor-pointer flex flex-col justify-center ${
          isActive 
            ? 'bg-amber-500/15 border-amber-500/40 text-amber-200 shadow-sm' 
            : hasWarning 
              ? 'hover:bg-slate-800/50 border-amber-500/25 text-slate-200' 
              : 'hover:bg-slate-800/40 text-slate-300'
        }`;

        let warningBadge = '';
        if (clsInfo) {
          warningBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold shrink-0 flex items-center gap-1">⚠️ ${clsInfo.status === 'suspended' ? 'Приостановлен' : 'Объезд'}</span>`;
        } else if (r.has_detour) {
          warningBadge = '<span class="px-2 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold shrink-0">⚠️ Объезд</span>';
        }

        row.innerHTML = `
          <div class="flex items-center justify-between gap-2.5">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-8 h-8 rounded-lg ${r.transport_type === 'tram' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'} flex items-center justify-center text-xs font-bold shrink-0">
                ${r.transport_type === 'tram' ? '🚊' : '🚎'}
              </span>
              <div class="min-w-0">
                <div class="text-xs font-bold text-white truncate flex items-center gap-1.5">
                  <span class="tracking-tight">${escapeHtml(r.title)}</span>
                  ${hasWarning ? '<span title="Внимание: схема движения изменена">⚠️</span>' : ''}
                </div>
                <div class="text-[11px] text-slate-300 mt-0.5 truncate font-normal">
                  ${r.endpoints?.from ? escapeHtml(r.endpoints.from) + ' ➔ ' + escapeHtml(r.endpoints.to || '') : 'Постоянный маршрут'}
                </div>
              </div>
            </div>
            ${warningBadge}
          </div>
          ${clsInfo?.description ? `
            <div class="mt-2 text-[11px] bg-amber-950/40 border border-amber-500/30 rounded-lg p-2 text-amber-200/90 leading-tight">
              <b>Изменение:</b> ${escapeHtml(clsInfo.description)}
            </div>
          ` : ''}
        `;
        row.onclick = () => selectRoute(uniqueId);
        container.appendChild(row);
      });
    }

    // Рендер списка остановок в сайдбаре (Impeccable: список с hairline-разделителями, min-height 44px)
    function renderStopsList(stops) {
      const listEl = document.getElementById('points-list');
      const counterEl = document.getElementById('filtered-stat');
      const visibleStops = (stops || []).filter(f => {
        if (f.is_visible === false) return false;
        if (f.properties?.is_visible === false || f.properties?.is_waypoint) return false;
        return true;
      });
      if (counterEl) counterEl.textContent = visibleStops.length;
      if (!listEl) return;
      listEl.innerHTML = '';

      if (visibleStops.length === 0) {
        listEl.innerHTML = '<div class="text-center py-6 text-xs text-slate-400">Остановки не найдены</div>';
        return;
      }

      visibleStops.forEach(f => {
        const name = f.properties?.name || 'Остановка';
        const coords = f.geometry?.coordinates; // [lon, lat]

        // Проверяем приближающиеся вагоны
        let approachingBadge = '';
        if (Array.isArray(window.latestPassengerVehicles) && coords && coords.length >= 2) {
          const stopLat = coords[1];
          const stopLon = coords[0];
          let minDistanceKm = 999;
          let nearestVeh = null;

          for (const v of window.latestPassengerVehicles) {
            const vType = (v.transport_type === 'trolleybus' || v.type === 'trolley' || v.type === 'trolleybus') ? 'trolleybus' : 'tram';
            if (vType !== currentType) continue;
            if (typeof v.lat === 'number' && typeof v.lon === 'number') {
              const dLat = (v.lat - stopLat) * 111.32;
              const dLon = (v.lon - stopLon) * (111.32 * Math.cos(stopLat * Math.PI / 180));
              const dist = Math.sqrt(dLat * dLat + dLon * dLon);
              if (dist < minDistanceKm) {
                minDistanceKm = dist;
                nearestVeh = v;
              }
            }
          }

          if (nearestVeh && minDistanceKm <= 1.4) {
            const approxMin = Math.max(1, Math.round(minDistanceKm / 0.3)); // средняя скорость по городу
            const vehIcon = currentType === 'tram' ? '🚋' : '🚎';
            const rNum = nearestVeh.route_id ? `№${nearestVeh.route_id} ` : '';
            approachingBadge = `<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold flex items-center gap-1 shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>${vehIcon} ${rNum}~${approxMin} мин</span>`;
          }
        }

        const item = document.createElement('div');
        item.className = 'stop-list-item min-h-[44px] px-3 py-2.5 rounded-xl border-b border-slate-800/60 hover:bg-slate-800/50 flex items-center justify-between gap-2.5 cursor-pointer transition-colors';
        item.innerHTML = `
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="text-xs shrink-0">${currentType === 'tram' ? '🚊' : '🚎'}</span>
            <span class="text-xs text-white truncate font-medium tracking-tight">${escapeHtml(name)}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${approachingBadge}
            <span class="text-xs text-amber-400 font-mono">📍</span>
          </div>
        `;
        item.onclick = () => {
          if (coords && coords.length >= 2) {
            focusOnStop(name, [coords[1], coords[0]]);
          }
        };
        listEl.appendChild(item);
      });
    }

    function getStopId(s) {
      if (s == null) return '';
      if (typeof s === 'object') return String(s.stop_id ?? s.id ?? '');
      return String(s);
    }

    function dismissRouteDetourBanner() {
      const banner = document.getElementById('route-detour-top-banner');
      if (banner) banner.classList.add('hidden');
    }

    // Глобальная функция выбора маршрута по клику из карточки остановки
    window.selectRouteFromCard = function (uniqueId, ev) {
      if (ev) {
        if (ev.stopPropagation) ev.stopPropagation();
        if (ev.preventDefault) ev.preventDefault();
      }
      selectRoute(uniqueId);
    };

    // Расчет примерного времени прибытия (ETA) ближайшего вагона к координатам остановки
    function calculateStopEta(stopCoords, passingRoutes) {
      if (!stopCoords || !Array.isArray(window.lastPassengerVehicles) || window.lastPassengerVehicles.length === 0) {
        return null;
      }
      const stopLat = stopCoords[0];
      const stopLon = stopCoords[1];

      // Если выбран конкретный маршрут, показываем ETA строго для него
      let passingRouteIds = new Set();
      if (typeof currentRouteId !== 'undefined' && currentRouteId) {
        passingRouteIds.add(String(currentRouteId));
      } else if (activeSelectedRouteData && activeSelectedRouteData.route_id) {
        passingRouteIds.add(String(activeSelectedRouteData.route_id));
      } else {
        passingRouteIds = new Set(passingRoutes.map(r => String(r.route_id || '')));
      }

      let nearest = null;
      let minDistance = Infinity;

      window.lastPassengerVehicles.forEach(v => {
        if (!v || v.lat == null || v.lon == null) return;
        const vRoute = String(v.route || v.route_id || '');
        if (passingRouteIds.size > 0 && !passingRouteIds.has(vRoute)) return;

        // Haversine
        const R = 6371000;
        const toRad = a => (a * Math.PI) / 180;
        const dLat = toRad(stopLat - v.lat);
        const dLon = toRad(stopLon - v.lon);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(v.lat)) * Math.cos(toRad(stopLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        if (dist < minDistance) {
          minDistance = dist;
          nearest = { vehicle: v, distance: dist };
        }
      });

      if (!nearest || nearest.distance > 8000) return null; // дальше 8 км не учитываем

      const speedMpm = 18 * 1000 / 60; // 300 м/мин (городской цикл)
      const minutes = Math.max(1, Math.round(nearest.distance / speedMpm));
      return {
        minutes: minutes,
        text: minutes <= 1 ? '< 1 мин' : `${minutes} мин`,
        route: nearest.vehicle.route || nearest.vehicle.route_id,
        vehType: nearest.vehicle.type || 'tram'
      };
    }

    // Отображение плашки статуса выбранной остановки в нижней шторке с расчетом ETA
    function showStopDetourNoticeInBottomSheet(stopInfo, passingRoutes = [], stopCoords = null) {
      const banner = document.getElementById('route-bottom-banner');
      if (!banner) return;

      const titleEl = document.getElementById('route-bottom-title');
      const statusEl = document.getElementById('route-bottom-status');
      const iconEl = document.getElementById('route-bottom-icon');
      const routesContainer = document.getElementById('route-bottom-routes-container');
      const routesList = document.getElementById('route-bottom-routes-list');

      titleEl.textContent = stopInfo.name;

      const isDetour = (stopInfo.status === 'skipped' || stopInfo.status === 'temporary' || stopInfo.isDetour);

      if (stopInfo.status === 'skipped') {
        if (iconEl) iconEl.textContent = '❌';
        statusEl.className = 'text-[11px] sm:text-xs font-bold text-rose-400 flex items-center gap-1.5 mt-0.5 flex-wrap';
        statusEl.innerHTML = `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px]">⚠️ Схема объезда</span><span>❌ Остановка временно закрыта${stopInfo.reason ? ': ' + escapeHtml(stopInfo.reason) : ''}</span>`;
      } else if (stopInfo.status === 'temporary') {
        if (iconEl) iconEl.textContent = '⚠️';
        statusEl.className = 'text-[11px] sm:text-xs font-bold text-amber-300 flex items-center gap-1.5 mt-0.5 flex-wrap';
        statusEl.innerHTML = `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px]">⚠️ Схема объезда</span><span>Временная остановка объезда${stopInfo.reason ? ': ' + escapeHtml(stopInfo.reason) : ''}</span>`;
      } else if (isDetour) {
        if (iconEl) iconEl.textContent = '⚠️';
        statusEl.className = 'text-[11px] sm:text-xs font-bold text-amber-300 flex items-center gap-1.5 mt-0.5 flex-wrap';
        statusEl.innerHTML = `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px]">⚠️ Схема объезда</span><span>${escapeHtml(stopInfo.reason || 'Движение временно изменено')}</span>`;
      } else {
        if (iconEl) iconEl.textContent = '🚏';
        const eta = stopCoords ? calculateStopEta(stopCoords, passingRoutes) : null;
        statusEl.className = 'text-[11px] sm:text-xs font-semibold text-emerald-400 flex items-center gap-1.5 mt-0.5 flex-wrap';
        if (eta) {
          statusEl.innerHTML = `<span>🟢 Ближайший вагон №${escapeHtml(eta.route)}: <strong class="text-amber-300 font-extrabold px-1.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-500/40">~${escapeHtml(eta.text)}</strong></span>`;
        } else {
          statusEl.innerHTML = `<span>🟢 Остановка действует в штатном режиме</span>`;
        }
      }

      if (routesContainer && routesList) {
        if (Array.isArray(passingRoutes) && passingRoutes.length > 0) {
          routesList.innerHTML = passingRoutes.map(r => `
            <button type="button"
                    onclick="window.selectRouteFromCard('${escapeHtml(r.uniqueId)}', event)"
                    title="Показать маршрут № ${escapeHtml(r.route_id)}"
                    class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-extrabold ${r.transport_type === 'tram' ? 'bg-blue-600 hover:bg-blue-500 border-blue-400/40' : 'bg-teal-600 hover:bg-teal-500 border-teal-400/40'} active:scale-95 text-white shadow-md border cursor-pointer transition-all">
              <span>${r.transport_type === 'tram' ? '🚋' : '🚎'}</span>
              <span>№ ${escapeHtml(r.route_id)}</span>
              ${(r.has_detour || r.is_detour_active) ? '<span class="text-[10px] text-amber-300 ml-0.5" title="Маршрут в режиме объезда">⚠️</span>' : ''}
            </button>
          `).join('');
          routesContainer.classList.remove('hidden');
        } else {
          routesContainer.classList.add('hidden');
        }
      }

      banner.classList.remove('hidden');
    }

    let activeSelectedRouteData = null;

    // Фокусировка на остановке: показ попапа и карточки со списком маршрутов
    function focusOnStop(name, latlng, extraInfo = null) {
      if (!map) return;
      map.setView(latlng, 16, { animate: true });

      // Определение feature остановки
      let feat = (extraInfo && (extraInfo.feature || (extraInfo.properties ? extraInfo : null))) || null;
      if (!feat && Array.isArray(currentStopsData)) {
        feat = currentStopsData.find(f => {
          if (f.properties?.name === name) return true;
          if (f.geometry?.coordinates && latlng) {
            const dLat = Math.abs(f.geometry.coordinates[1] - latlng[0]);
            const dLon = Math.abs(f.geometry.coordinates[0] - latlng[1]);
            return dLat < 0.0002 && dLon < 0.0002;
          }
          return false;
        });
      }

      // Получаем список всех проходящих маршрутов
      const passingRoutes = getPassingRoutesForStop(feat, name);

      // Проверяем статус объезда / перекрытия
      let detourReason = (extraInfo && extraInfo.reason) || '';
      let isDetour = isStopUnderDetour(feat, name, passingRoutes) || (extraInfo && (extraInfo.status === 'skipped' || extraInfo.status === 'temporary'));

      if (!detourReason && passingRoutes.some(r => r.detour_reason)) {
        detourReason = passingRoutes.find(r => r.detour_reason)?.detour_reason || '';
      }

      if (!extraInfo && activeSelectedRouteData) {
        const routeReason = activeSelectedRouteData.detour_info?.reason || activeSelectedRouteData.detour_reason || '';
        const routeTitle = activeSelectedRouteData.title || `Маршрут № ${currentRouteId}`;

        let foundStatus = null;
        ['direct', 'return'].forEach(dk => {
          const dir = activeSelectedRouteData.directions?.[dk];
          if (!dir || foundStatus) return;
          if (Array.isArray(dir.tagged_stops)) {
            const st = dir.tagged_stops.find(s => (s.name === name || getStopId(s) === name));
            if (st) foundStatus = st.status;
          }
        });

        if (foundStatus) {
          extraInfo = {
            name: name,
            status: foundStatus,
            routeTitle: routeTitle,
            reason: routeReason,
            feature: feat
          };
          if (foundStatus === 'skipped' || foundStatus === 'temporary') {
            isDetour = true;
            if (!detourReason) detourReason = routeReason;
          }
        }
      }

      // 1. Формирование цветных бейджей проходящих маршрутов
      let routesBadgeHtml = '';
      if (passingRoutes.length > 0) {
        const badges = passingRoutes.map(r => `
          <button type="button"
                  onclick="window.selectRouteFromCard('${escapeHtml(r.uniqueId)}', event)"
                  title="Выбрать маршрут № ${escapeHtml(r.route_id)}"
                  class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-extrabold ${r.transport_type === 'tram' ? 'bg-blue-600 hover:bg-blue-500 border-blue-400/40' : 'bg-teal-600 hover:bg-teal-500 border-teal-400/40'} active:scale-95 text-white shadow-md border cursor-pointer transition-all">
            <span>${r.transport_type === 'tram' ? '🚋' : '🚎'}</span>
            <span>№ ${escapeHtml(r.route_id)}</span>
            ${(r.has_detour || r.is_detour_active) ? '<span class="text-[10px] text-amber-300 ml-0.5" title="Маршрут в режиме объезда">⚠️</span>' : ''}
          </button>
        `).join('');

        routesBadgeHtml = `
          <div class="mt-2.5 pt-2 border-t border-slate-700/60">
            <div class="text-[10px] font-bold uppercase tracking-wider text-slate-300 mb-1.5 flex items-center gap-1">
              <span>Проходящие маршруты:</span>
            </div>
            <div class="flex flex-wrap gap-1.5 items-center">
              ${badges}
            </div>
          </div>
        `;
      } else {
        routesBadgeHtml = `
          <div class="mt-2 text-[10px] text-slate-400">
            Маршруты через остановку уточняются
          </div>
        `;
      }

      // 2. Блок предупреждения об объезде / закрытии
      let detourBadgeHtml = '';
      if (extraInfo && extraInfo.status === 'skipped') {
        detourBadgeHtml = `
          <div class="my-1.5">
            <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
              <span>⚠️</span>
              <span>Схема объезда</span>
            </div>
            <div class="text-xs font-bold text-rose-400 mt-1">❌ Остановка временно закрыта (объезд)</div>
            <div class="text-[11px] text-slate-300 mt-0.5 leading-snug">${escapeHtml(extraInfo.reason || 'Посадка и высадка пассажиров временно не производятся')}</div>
          </div>
        `;
      } else if (extraInfo && extraInfo.status === 'temporary') {
        detourBadgeHtml = `
          <div class="my-1.5">
            <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
              <span>⚠️</span>
              <span>Схема объезда</span>
            </div>
            <div class="text-xs font-bold text-amber-300 mt-1">Временная остановка объезда</div>
            <div class="text-[11px] text-amber-200 mt-0.5 leading-snug">${escapeHtml(extraInfo.reason || 'Маршрут следует по измененной схеме движения')}</div>
          </div>
        `;
      } else if (isDetour) {
        detourBadgeHtml = `
          <div class="my-1.5">
            <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
              <span>⚠️</span>
              <span>Схема объезда</span>
            </div>
            <div class="text-[11px] text-amber-200/90 mt-1 leading-snug">${escapeHtml(detourReason || 'Маршрут(ы) через данную остановку следуют по измененной схеме')}</div>
          </div>
        `;
      } else {
        detourBadgeHtml = `
          <div class="text-[11px] text-emerald-400 font-semibold flex items-center gap-1 my-1">
            <span>🟢</span>
            <span>Остановка действует в штатном режиме</span>
          </div>
        `;
      }

      // 3. Формирование HTML содержимого попапа (название крупным жирным шрифтом, бейдж объезда, синие плашки маршрутов)
      const popupContent = `
        <div class="p-1 min-w-[210px] max-w-[290px]">
          <div class="text-sm sm:text-base font-extrabold text-white leading-tight">
            ${escapeHtml(name)}
          </div>
          ${detourBadgeHtml}
          ${routesBadgeHtml}
        </div>
      `;

      L.popup()
        .setLatLng(latlng)
        .setContent(popupContent)
        .openOn(map);

      // Обновляем нижнюю шторку с расчетом времени прибытия (ETA)
      showStopDetourNoticeInBottomSheet({
        name: name,
        status: extraInfo?.status || (isDetour ? 'detour' : 'active'),
        isDetour: isDetour,
        reason: detourReason || extraInfo?.reason
      }, passingRoutes, latlng ? [latlng[0] || latlng.lat, latlng[1] || latlng.lng] : null);

      if (window.innerWidth < 640) {
        toggleSidebarCollapse(true);
      }
    }

    // Построение плавной трассы по путям для пассажирской карты
    function extractTrackSegmentBetweenPoints(latlngA, latlngB) {
      const tracksGeo = window.publicTracksGeo;
      if (!tracksGeo || !tracksGeo.features || !map) return [latlngA, latlngB];

      try {
        const pA = [latlngA[0], latlngA[1]];
        const pB = [latlngB[0], latlngB[1]];

        let bestFeatureCoords = null;
        let bestIndexA = -1;
        let bestIndexB = -1;
        let minSumDist = Infinity;

        tracksGeo.features.forEach(feat => {
          const geom = feat.geometry;
          if (!geom) return;

          let lines = [];
          if (geom.type === 'LineString') {
            lines = [geom.coordinates];
          } else if (geom.type === 'MultiLineString') {
            lines = geom.coordinates;
          }

          lines.forEach(lineCoords => {
            if (!lineCoords || lineCoords.length < 2) return;

            let localBestA = -1;
            let localDistA = Infinity;
            let localBestB = -1;
            let localDistB = Infinity;

            for (let i = 0; i < lineCoords.length; i++) {
              const ptLat = lineCoords[i][1];
              const ptLon = lineCoords[i][0];
              const dA = map.distance(pA, [ptLat, ptLon]);
              const dB = map.distance(pB, [ptLat, ptLon]);

              if (dA < localDistA) {
                localDistA = dA;
                localBestA = i;
              }
              if (dB < localDistB) {
                localDistB = dB;
                localBestB = i;
              }
            }

            if (localDistA < 250 && localDistB < 250) {
              const sumDist = localDistA + localDistB;
              if (sumDist < minSumDist) {
                minSumDist = sumDist;
                bestFeatureCoords = lineCoords;
                bestIndexA = localBestA;
                bestIndexB = localBestB;
              }
            }
          });
        });

        if (bestFeatureCoords && bestIndexA !== -1 && bestIndexB !== -1) {
          const startIdx = Math.min(bestIndexA, bestIndexB);
          const endIdx = Math.max(bestIndexA, bestIndexB);
          const trackSlice = [];

          if (bestIndexA <= bestIndexB) {
            for (let i = startIdx; i <= endIdx; i++) {
              trackSlice.push([bestFeatureCoords[i][1], bestFeatureCoords[i][0]]);
            }
          } else {
            for (let i = endIdx; i >= startIdx; i--) {
              trackSlice.push([bestFeatureCoords[i][1], bestFeatureCoords[i][0]]);
            }
          }

          if (trackSlice.length >= 2) {
            return trackSlice;
          }
        }
      } catch (err) {
        console.error('public extractTrackSegmentBetweenPoints error:', err);
      }

      return [latlngA, latlngB];
    }

    function buildTrackSnappedPath(points) {
      if (!points || points.length === 0) return [];
      if (points.length === 1) return [points[0]];

      const fullTrackPath = [];
      for (let i = 0; i < points.length - 1; i++) {
        const seg = extractTrackSegmentBetweenPoints(points[i], points[i + 1]);
        if (seg && seg.length > 0) {
          if (fullTrackPath.length > 0) {
            seg.shift();
          }
          fullTrackPath.push(...seg);
        } else {
          if (fullTrackPath.length === 0) fullTrackPath.push(points[i]);
          fullTrackPath.push(points[i + 1]);
        }
      }
      return fullTrackPath.length >= 2 ? fullTrackPath : points;
    }

    // 4. Подсветка остановок выбранного маршрута с синхронизацией схемы объезда
    async function selectRoute(routeId) {
      currentRouteId = routeId;
      document.querySelectorAll('.route-pill-btn').forEach(btn => btn.classList.remove('active'));
      const activePill = document.getElementById(`pill-${routeId}`);
      if (activePill) activePill.classList.add('active');

      const selectEl = document.getElementById('route-select');
      if (selectEl) selectEl.value = routeId;

      const banner = document.getElementById('route-bottom-banner');

      if (highlightStopsLayer) {
        map.removeLayer(highlightStopsLayer);
        highlightStopsLayer = null;
      }

      if (routeId === 'all') {
        activeSelectedRouteData = null;
        dismissRouteDetourBanner();
        if (banner) banner.classList.add('hidden');
        renderRoutesList(allRoutes);
        syncPublicStopsLayerMask([]);
        updateCompactSheetBar();
        return;
      }

      try {
        const res = await apiFetch(`/api/geo/routes/${routeId}`);
        const routeData = await res.json();
        activeSelectedRouteData = routeData;
        updateCompactSheetBar();

        const isDetourActive = Boolean(routeData.is_detour_active || routeData.has_detour);
        const detourReason = routeData.detour_info?.reason || routeData.detour_reason || '';
        const detourTitle = routeData.detour_info?.title || routeData.title || `Маршрут № ${routeId}`;

        // Отображение компактного баннера объезда вверху экрана
        const detourBanner = document.getElementById('route-detour-top-banner');
        const detourBannerText = document.getElementById('route-detour-banner-text');
        if (detourBanner && detourBannerText) {
          if (isDetourActive) {
            const reasonSuffix = detourReason ? `: ${detourReason}` : (detourTitle ? `: ${detourTitle}` : '');
            detourBannerText.textContent = `⚠️ Маршрут следует по измененной схеме движения${reasonSuffix}`;
            detourBanner.classList.remove('hidden');
          } else {
            detourBanner.classList.add('hidden');
          }
        }

        // Показываем плашку внизу
        if (banner) {
          const rNum = String(routeData.route_id || routeId);
          const clsInfo = getRouteClosureInfo(rNum, routeData.transport_type || currentType);
          const statusEl = document.getElementById('route-bottom-status');
          const iconEl = document.getElementById('route-bottom-icon');

          document.getElementById('route-bottom-title').textContent = routeData.title || `Маршрут № ${routeId}`;
          if (clsInfo) {
            statusEl.className = 'text-[11px] sm:text-xs font-semibold text-amber-400 flex items-center gap-1.5 mt-0.5';
            statusEl.innerHTML = `<span>⚠️ ${escapeHtml(clsInfo.description)}</span>`;
            if (iconEl) iconEl.textContent = '⚠️';
          } else if (isDetourActive) {
            statusEl.className = 'text-[11px] sm:text-xs font-semibold text-amber-300 flex items-center gap-1.5 mt-0.5';
            statusEl.innerHTML = `<span>🚧 Маршрут следует по схеме объезда${detourReason ? ': ' + escapeHtml(detourReason) : ''}</span>`;
            if (iconEl) iconEl.textContent = '🚧';
          } else {
            statusEl.className = 'text-[11px] sm:text-xs font-semibold text-emerald-400 flex items-center gap-1.5 mt-0.5';
            statusEl.innerHTML = `<span>🟢 Движение по расписанию</span>`;
            if (iconEl) iconEl.textContent = routeData.transport_type === 'tram' ? '🚋' : '🚎';
          }
          banner.classList.remove('hidden');
        }

        highlightStopsLayer = L.featureGroup();
        const boundsCoords = [];

        // Маскируем опорные точки пути на общем слое карты, чтобы для пассажиров они не рисовались маркерами
        const routeWaypoints = [];
        ['direct', 'return'].forEach(dk => {
          const dir = routeData.directions?.[dk];
          if (!dir) return;
          const allPoints = dir.active_stops || (isDetourActive && dir.detour_stops?.length ? dir.detour_stops : dir.stops) || [];
          allPoints.forEach(p => {
            if (p.is_visible === false || p.is_waypoint) routeWaypoints.push(p);
          });
        });
        syncPublicStopsLayerMask(routeWaypoints);

        // 1. Отрисовка трассы сквозь ВСЕ точки (и официальные, и скрытые опорные точки для идеального изгиба)
        const activeDirs = (currentPublicDirection === 'direct') ? ['direct'] : (currentPublicDirection === 'return') ? ['return'] : ['direct', 'return'];
        activeDirs.forEach(dirKey => {
          const dir = routeData.directions?.[dirKey];
          if (!dir) return;

          const allPoints = dir.active_stops || (isDetourActive && dir.detour_stops?.length ? dir.detour_stops : dir.stops) || [];
          const dirCoords = allPoints.map(s => {
            if (Array.isArray(s.coords) && s.coords.length >= 2) return [Number(s.coords[0]), Number(s.coords[1])];
            if (Array.isArray(s.coordinates) && s.coordinates.length >= 2) return [Number(s.coordinates[1]), Number(s.coordinates[0])];
            return null;
          }).filter(Boolean);

          if (dirCoords.length >= 2) {
            const snapped = buildTrackSnappedPath(dirCoords);
            const lineColor = isDetourActive ? '#F59E0B' : (routeData.transport_type === 'tram' ? '#0284c7' : '#059669');
            const routeLine = L.polyline(snapped, {
              color: lineColor,
              weight: isDetourActive ? 5 : 4.5,
              opacity: 0.92,
              lineCap: 'round',
              lineJoin: 'round',
              dashArray: isDetourActive ? '10, 8' : undefined
            });
            highlightStopsLayer.addLayer(routeLine);
            snapped.forEach(pt => boundsCoords.push(pt));
          }
        });

        // 2. Сбор официальных остановок пассажиров (точки с is_visible === false || is_waypoint ИСКЛЮЧАЮТСЯ из маркеров)
        const stopEntries = new Map();

        activeDirs.forEach(dirKey => {
          const dir = routeData.directions?.[dirKey];
          if (!dir) return;

          if (Array.isArray(dir.tagged_stops) && dir.tagged_stops.length > 0) {
            dir.tagged_stops.forEach(st => {
              if (st.is_visible === false || st.is_waypoint) return; // Скрытая опорная точка — не выводим пассажиру
              const sid = getStopId(st);
              if (!sid) return;
              const prev = stopEntries.get(sid);
              if (!prev || (prev.status === 'skipped' && st.status !== 'skipped')) {
                stopEntries.set(sid, { stop: st, status: st.status || 'active' });
              }
            });
          } else {
            const regStops = (dir.regular_stops || dir.stops || []).filter(s => s.is_visible !== false && !s.is_waypoint);
            const detStops = (dir.detour_stops || []).filter(s => s.is_visible !== false && !s.is_waypoint);
            const regIdSet = new Set(regStops.map(getStopId));
            const detIdSet = new Set(detStops.map(getStopId));

            if (isDetourActive && detStops.length > 0) {
              detStops.forEach(st => {
                const sid = getStopId(st);
                if (!sid) return;
                const status = regIdSet.has(sid) ? 'active' : 'temporary';
                stopEntries.set(sid, { stop: st, status });
              });
              regStops.forEach(st => {
                const sid = getStopId(st);
                if (!sid) return;
                if (!detIdSet.has(sid) && !stopEntries.has(sid)) {
                  stopEntries.set(sid, { stop: st, status: 'skipped' });
                }
              });
            } else {
              regStops.forEach(st => {
                const sid = getStopId(st);
                if (sid && !stopEntries.has(sid)) {
                  stopEntries.set(sid, { stop: st, status: 'active' });
                }
              });
            }
          }
        });

        // 3. Отрисовка маркеров только официальных остановок
        stopEntries.forEach(({ stop: st, status }) => {
          if (st.is_visible === false || st.is_waypoint) return;
          let latlng = null;
          if (Array.isArray(st.coords) && st.coords.length >= 2) latlng = [Number(st.coords[0]), Number(st.coords[1])];
          else if (Array.isArray(st.coordinates) && st.coordinates.length >= 2) latlng = [Number(st.coordinates[1]), Number(st.coordinates[0])];
          if (!latlng) return;

          boundsCoords.push(latlng);
          const stopName = st.name || st.stop_id || 'Остановка';
          const routeTitle = routeData.title || `Маршрут № ${routeId}`;

          let marker;
          if (status === 'skipped') {
            // ❌ Closed / Skipped stop
            const closedIcon = L.divIcon({
              className: 'route-stop-div-icon',
              html: `<div class="route-stop-closed-pin" title="Остановка временно закрыта (объезд)">❌</div>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13]
            });
            marker = L.marker(latlng, { icon: closedIcon, zIndexOffset: 50 });
            marker.bindTooltip(
              `<span class="line-through text-slate-400 font-bold">${escapeHtml(stopName)}</span> <b class="text-rose-400 text-[10px] ml-1">(Закрыта)</b>`,
              {
                direction: 'top',
                offset: [0, -10],
                className: 'bg-slate-950 text-slate-300 text-[11px] px-2.5 py-1 rounded-xl border border-rose-500/40 shadow-2xl'
              }
            );
            marker.on('click', (e) => {
              if (e) L.DomEvent.stopPropagation(e);
              focusOnStop(stopName, latlng, {
                status: 'skipped',
                routeTitle: routeTitle,
                reason: detourReason,
                feature: st
              });
            });
          } else if (status === 'temporary') {
            // ⚠️ Temporary detour stop
            const tempIcon = L.divIcon({
              className: 'route-stop-div-icon',
              html: `<div class="route-stop-detour-temp-pin" title="Временная остановка объезда">⚠️</div>`,
              iconSize: [28, 28],
              iconAnchor: [14, 14]
            });
            marker = L.marker(latlng, { icon: tempIcon, zIndexOffset: 100 });
            marker.bindTooltip(
              `<b>⚠️ Временная остановка: ${escapeHtml(stopName)}</b>`,
              {
                direction: 'top',
                offset: [0, -12],
                className: 'bg-amber-950 text-amber-200 text-[11px] font-bold px-2.5 py-1 rounded-xl border border-amber-500 shadow-2xl'
              }
            );
            marker.on('click', (e) => {
              if (e) L.DomEvent.stopPropagation(e);
              focusOnStop(stopName, latlng, {
                status: 'temporary',
                routeTitle: routeTitle,
                reason: detourReason,
                feature: st
              });
            });
          } else {
            // Active regular stop (базовый радиус 8px, ховер 11px, обводка белая 2px, насыщенная синяя заливка, хитбокс 20px)
            const hitbox = L.circleMarker(latlng, {
              radius: 20,
              stroke: false,
              fillColor: '#000000',
              fillOpacity: 0.0001,
              interactive: true
            });
            const visual = L.circleMarker(latlng, {
              radius: 8,
              fillColor: '#1d4ed8',
              color: '#ffffff',
              weight: 2,
              opacity: 1,
              fillOpacity: 1,
              interactive: true
            });

            function onHover() {
              visual.setRadius(11);
              visual.setStyle({ fillColor: '#2563eb' });
            }
            function onLeave() {
              visual.setRadius(8);
              visual.setStyle({ fillColor: '#1d4ed8' });
            }

            hitbox.on('mouseover', onHover);
            hitbox.on('mouseout', onLeave);
            visual.on('mouseover', onHover);
            visual.on('mouseout', onLeave);

            function onActiveStopClick(e) {
              if (e) L.DomEvent.stopPropagation(e);
              focusOnStop(stopName, latlng, {
                status: 'active',
                routeTitle: routeTitle,
                feature: st
              });
            }
            hitbox.on('click', onActiveStopClick);
            visual.on('click', onActiveStopClick);

            visual.bindTooltip(`<b>${escapeHtml(stopName)}</b>`, {
              direction: 'top',
              offset: [0, -10],
              className: 'bg-slate-900 text-white text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-700 shadow-xl'
            });

            marker = L.featureGroup([hitbox, visual]);
          }

          highlightStopsLayer.addLayer(marker);
        });

        highlightStopsLayer.addTo(map);

        if (boundsCoords.length > 0) {
          map.fitBounds(L.latLngBounds(boundsCoords), { padding: [50, 50] });
        }

        renderRoutesList(allRoutes);
      } catch (err) {
        console.error('Failed to fetch route details:', err);
      }
    }

    // ============================================================
    // ИНТЕГРАЦИЯ ИНЦИДЕНТОВ И ПЕРЕКРЫТИЙ (/api/incidents + /api/closures/active)
    // ============================================================
    let activeIncidentsList = [];
    let passengerIncidentsLayer = null;

    async function loadActiveClosures() {
      try {
        const [resClosures, resIncidents] = await Promise.allSettled([
          apiFetch('/api/closures/active'),
          apiFetch('/api/incidents?status=active')
        ]);

        if (resClosures.status === 'fulfilled' && resClosures.value.ok) {
          activeClosures = await resClosures.value.json();
        } else {
          activeClosures = [];
        }

        if (resIncidents.status === 'fulfilled' && resIncidents.value.ok) {
          activeIncidentsList = await resIncidents.value.json();
        } else {
          activeIncidentsList = [];
        }

        renderClosuresOnMap();
        renderIncidentsOnMap();
        updateTopClosureBanner();
        updateIncidentWarningBanners();

        // Перерисовываем пилюли и каталог с учетом перекрытий
        renderRoutePills();
        renderRoutesList(allRoutes);
      } catch (e) {
        console.error('Failed to load active closures/incidents:', e);
      }
    }

    const CLIENT_DETOUR_TEMPLATES = [
      {
        id: "template_damba_sviyaga",
        keywords: ["дамб", "свияг", "аквамолл", "мостовая", "шевченко", "damba"],
        blocked_segment: { coordinates: [[54.3146, 48.3855], [54.3135, 48.3800], [54.3115, 48.3680], [54.3072, 48.3542]] },
        detour_path: { coordinates: [[54.3146, 48.3855], [54.3160, 48.3880], [54.3210, 48.3820], [54.3280, 48.3730]] }
      },
      {
        id: "template_radischeva_sever",
        keywords: ["радищев", "северный венец", "тимирязев", "тухачевск", "пластов", "radischeva"],
        blocked_segment: { coordinates: [[54.3180, 48.3980], [54.3260, 48.3980], [54.3350, 48.3980], [54.344287, 48.392806]] },
        detour_path: { coordinates: [[54.3465, 48.3970], [54.3490, 48.3800], [54.3400, 48.3700], [54.3146, 48.3855]] }
      },
      {
        id: "template_pushkareva_zavodskaya",
        keywords: ["пушкарев", "заводск", "московское", "станкостроител", "октябрьск", "богдана хмельницкого", "гидроаппарат", "pushkareva"],
        blocked_segment: { coordinates: [[54.3072, 48.3542], [54.3020, 48.3510], [54.2985, 48.3480]] },
        detour_path: { coordinates: [[54.2985, 48.3480], [54.2950, 48.3445], [54.2920, 48.3380]] }
      },
      {
        id: "template_kirova_vokzal",
        keywords: ["киров", "вокзал", "жд вокзал", "инзенск", "винновк", "kirova"],
        blocked_segment: { coordinates: [[54.3125, 48.3932], [54.3050, 48.3890], [54.2980, 48.3850]] },
        detour_path: { coordinates: [[54.2980, 48.3850], [54.2880, 48.3750], [54.2750, 48.3650]] }
      },
      {
        id: "template_ryabikova_kamyshinskaya",
        keywords: ["рябиков", "камышинск", "уксм", "ryabikova"],
        blocked_segment: { coordinates: [[54.2921, 48.3412], [54.2831, 48.3225], [54.2798, 48.3142]] },
        detour_path: { coordinates: [[54.2798, 48.3142], [54.2740, 48.3030], [54.2697, 48.2918]] }
      }
    ];

    function findClientDetourTemplate(str) {
      if (!str) return null;
      const s = String(str).toLowerCase();
      return CLIENT_DETOUR_TEMPLATES.find(t => t.keywords.some(k => s.includes(k))) || null;
    }

    let reopenedBannerTimeout = null;
    function showReopenedCelebrationBanner(title, routes) {
      const banner = document.getElementById('reopened-celebration-toast');
      if (!banner) return;
      const titleEl = document.getElementById('reopened-toast-title');
      const routesEl = document.getElementById('reopened-toast-routes');
      const rStr = Array.isArray(routes) ? routes.join(', ') : (routes || '');

      if (titleEl) titleEl.textContent = title ? `Возобновлено: ${title}` : 'Движение полностью открыто!';
      if (routesEl) {
        routesEl.textContent = rStr ? `№ ${rStr}` : 'Все пути';
        routesEl.style.display = 'inline-block';
      }

      banner.classList.remove('hidden');
      banner.style.display = 'flex';

      if (reopenedBannerTimeout) clearTimeout(reopenedBannerTimeout);
      reopenedBannerTimeout = setTimeout(() => {
        banner.classList.add('hidden');
        banner.style.display = 'none';
      }, 25000);
    }
    window.showReopenedCelebrationBanner = showReopenedCelebrationBanner;

    function renderIncidentsOnMap() {
      if (passengerIncidentsLayer && map) {
        map.removeLayer(passengerIncidentsLayer);
        passengerIncidentsLayer = null;
      }

      if (!activeIncidentsList || activeIncidentsList.length === 0) return;

      passengerIncidentsLayer = L.featureGroup().addTo(map);

      activeIncidentsList.forEach(inc => {
        let coords = inc.blocked_segment?.coordinates;
        // Fallback: извлечение координат из закрытых остановок или BBox
        if ((!Array.isArray(coords) || coords.length === 0) && Array.isArray(inc.blocked_segment?.closed_stops) && inc.blocked_segment.closed_stops.length > 0) {
          coords = inc.blocked_segment.closed_stops
            .filter(st => st.lat && st.lng)
            .map(st => [st.lat, st.lng]);
        }
        if ((!Array.isArray(coords) || coords.length === 0) && Array.isArray(inc.blocked_segment?.coordinates_bbox) && inc.blocked_segment.coordinates_bbox.length > 0) {
          coords = inc.blocked_segment.coordinates_bbox;
        }

        // Автоматический fallback на геометрию типовых шаблонов объезда
        if (!Array.isArray(coords) || coords.length < 2) {
          const tKey = `${inc.detour_id || ''} ${inc.street_name || ''} ${inc.title || ''} ${inc.announcement_text || ''}`.toLowerCase();
          const matchedTpl = findClientDetourTemplate(tKey);
          if (matchedTpl) {
            coords = matchedTpl.blocked_segment?.coordinates;
            if (!inc.detour_path || !Array.isArray(inc.detour_path.coordinates)) {
              inc.detour_path = matchedTpl.detour_path;
            }
          }
        }

        const detourCoords = inc.detour_path?.coordinates;
        const title = inc.title || 'Оперативное перекрытие';
        const msg = inc.announcement_text || inc.raw_text || '';
        const routesStr = (inc.affected_routes || []).join(', ');

        const dirMeta = (window.UETClosures?.getClosureDirectionMeta)
          ? window.UETClosures.getClosureDirectionMeta(inc.direction || inc.blocked_segment?.direction)
          : {
              key: 'both',
              label: 'Движение закрыто В ОБЕ СТОРОНЫ',
              shortLabel: 'В оба направления',
              icon: '🔄',
              badge: '🔄 В оба направления',
              color: '#ef4444',
              bgClass: 'bg-rose-950/90',
              borderClass: 'border-rose-500/60',
              textClass: 'text-rose-300'
            };

        const popupContent = (window.UETClosures?.buildIncidentPopupHtml)
          ? window.UETClosures.buildIncidentPopupHtml(inc, escapeHtml)
          : `
            <div class="space-y-1.5 p-1 min-w-[220px]">
              <div class="flex items-center justify-between gap-1 border-b border-slate-800 pb-1">
                <span class="text-xs font-bold text-rose-400">⛔ ПЕРЕКРЫТИЕ ПУТЕЙ</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-950 border border-rose-600 text-rose-300 font-bold">${dirMeta.icon} ${dirMeta.shortLabel}</span>
              </div>
              <div class="text-xs text-white font-bold">${escapeHtml(title)}</div>
              <div class="text-[11px] text-amber-300 font-semibold">${dirMeta.icon} ${dirMeta.label}</div>
              <div class="text-[11px] text-slate-200 leading-snug">${escapeHtml(msg)}</div>
              <div class="text-[10px] text-amber-300 font-mono font-bold mt-1">Затронуты маршруты: № ${escapeHtml(routesStr || 'Все')}</div>
            </div>
          `;

        if (Array.isArray(coords) && coords.length >= 2) {
          const snappedBlocked = (typeof buildTrackSnappedPath === 'function')
            ? buildTrackSnappedPath(coords)
            : coords;

          // 1. Внешний пульсирующий ореол свечения
          L.polyline(snappedBlocked, {
            color: '#ef4444',
            weight: 12,
            opacity: 0.35,
            lineCap: 'round',
            lineJoin: 'round',
            className: 'pulsing-blocked-segment-glow',
            interactive: false
          }).addTo(passengerIncidentsLayer);

          // 2. Основная насыщенная красная линия перекрытия
          const polyline = L.polyline(snappedBlocked, {
            color: '#dc2626',
            weight: 6,
            opacity: 0.98,
            lineCap: 'round',
            lineJoin: 'round',
            className: 'pulsing-blocked-segment'
          }).addTo(passengerIncidentsLayer);
          polyline.bindPopup(popupContent);

          // 3. Внутренняя контрастная пунктирная нить
          L.polyline(snappedBlocked, {
            color: '#ffffff',
            weight: 2,
            dashArray: '6, 6',
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false
          }).addTo(passengerIncidentsLayer);

          // 4. Плавающий бейдж направления по центру отрезка
          const midIdx = Math.floor(snappedBlocked.length / 2);
          const centerPt = snappedBlocked[midIdx];
          const dirBadgeIcon = L.divIcon({
            className: 'passenger-incident-direction-badge',
            html: `
              <div class="px-2.5 py-1 rounded-full ${dirMeta.bgClass} text-white border ${dirMeta.borderClass} shadow-2xl flex items-center gap-1.5 text-[11px] font-bold tracking-tight select-none cursor-pointer hover:scale-105 transition-transform ring-2 ring-rose-500/30 whitespace-nowrap">
                <span class="text-rose-400 font-black">⛔</span>
                <span>${escapeHtml(dirMeta.badge)}</span>
              </div>
            `,
            iconAnchor: [60, 14]
          });
          L.marker(centerPt, { icon: dirBadgeIcon, zIndexOffset: 2500 })
            .addTo(passengerIncidentsLayer)
            .bindPopup(popupContent);

          // 5. Концевые маркеры ⛔
          [snappedBlocked[0], snappedBlocked[snappedBlocked.length - 1]].forEach(pt => {
            const endIcon = L.divIcon({
              className: 'passenger-incident-end-pin',
              html: `
                <div style="background:#dc2626; color:#ffffff; border:2px solid #ffffff; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; box-shadow:0 0 10px rgba(220,38,38,0.9); cursor:pointer;">
                  ⛔
                </div>
              `,
              iconSize: [22, 22],
              iconAnchor: [11, 11]
            });
            L.marker(pt, { icon: endIcon, zIndexOffset: 2400 })
              .addTo(passengerIncidentsLayer)
              .bindPopup(popupContent);
          });
        } else if (Array.isArray(coords) && coords.length === 1) {
          // Если одна точка (одиночная остановка)
          const warnIcon = L.divIcon({
            className: 'passenger-incident-pin',
            html: `
              <div class="px-2 py-1 rounded-full bg-rose-600 text-white flex items-center gap-1 text-[11px] font-bold shadow-xl border border-white ring-2 ring-rose-500/50 cursor-pointer">
                <span>⛔</span>
                <span>${escapeHtml(dirMeta.badge)}</span>
              </div>
            `,
            iconAnchor: [40, 14]
          });
          L.marker(coords[0], { icon: warnIcon, zIndexOffset: 2500 })
            .addTo(passengerIncidentsLayer)
            .bindPopup(popupContent);
        }

        // Если есть путь объезда — отображаем плотной янтарной/зеленой линией со стрелками
        if (Array.isArray(detourCoords) && detourCoords.length >= 2) {
          const snappedDetour = (typeof buildTrackSnappedPath === 'function')
            ? buildTrackSnappedPath(detourCoords)
            : detourCoords;

          const detourPoly = L.polyline(snappedDetour, {
            color: '#10b981',
            weight: 5,
            dashArray: '6, 6',
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(passengerIncidentsLayer);

          detourPoly.bindPopup(`
            <div class="p-1 space-y-1 min-w-[220px]">
              <div class="flex items-center gap-1.5 text-xs font-bold text-emerald-400 border-b border-slate-800 pb-1">
                <span>⚡</span>
                <span>СХЕМА ОБЪЕЗДА ВАГОНОВ</span>
              </div>
              <div class="text-[11px] text-white leading-snug">${escapeHtml(msg || title)}</div>
              <div class="text-[10px] text-slate-300 font-mono mt-1">Маршруты: ${escapeHtml(routesStr)}</div>
            </div>
          `);
        }
      });
    }

    // Обновление предупреждающего баннера в нижней шторке над списком остановок
    function updateIncidentWarningBanners() {
      const stopsBanner = document.getElementById('stops-incident-warning-banner');
      const routesBanner = document.getElementById('routes-incident-warning-banner');

      // Ищем первый активный инцидент из /api/incidents или активное перекрытие
      const primaryIncident = (activeIncidentsList && activeIncidentsList.length > 0)
        ? activeIncidentsList[0]
        : ((activeClosures && activeClosures.length > 0) ? {
            title: activeClosures[0].passenger_alert?.title || activeClosures[0].blocked_segment?.title,
            announcement_text: activeClosures[0].passenger_alert?.message,
            affected_routes: activeClosures[0].affected_routes
          } : null);

      if (!primaryIncident) {
        if (stopsBanner) {
          stopsBanner.classList.add('hidden');
          stopsBanner.style.display = 'none';
        }
        if (routesBanner) {
          routesBanner.classList.add('hidden');
          routesBanner.style.display = 'none';
        }
        return;
      }

      const rawText = primaryIncident.announcement_text || primaryIncident.title || 'Временное изменение движения';
      const displayText = rawText.startsWith('⚠️') ? rawText : `⚠️ Внимание: ${rawText}`;
      const routesText = (primaryIncident.affected_routes && primaryIncident.affected_routes.length > 0)
        ? `№ ${primaryIncident.affected_routes.join(', ')}`
        : '';

      if (stopsBanner) {
        const textEl = document.getElementById('stops-incident-text');
        const badgeEl = document.getElementById('stops-incident-routes-badge');
        if (textEl) textEl.textContent = displayText;
        if (badgeEl) {
          badgeEl.textContent = routesText;
          badgeEl.style.display = routesText ? 'inline-block' : 'none';
        }
        stopsBanner.classList.remove('hidden');
        stopsBanner.style.display = 'block';
      }

      if (routesBanner) {
        const rTextEl = document.getElementById('routes-incident-text');
        const rBadgeEl = document.getElementById('routes-incident-routes-badge');
        if (rTextEl) rTextEl.textContent = displayText;
        if (rBadgeEl) {
          rBadgeEl.textContent = routesText;
          rBadgeEl.style.display = routesText ? 'inline-block' : 'none';
        }
        routesBanner.classList.remove('hidden');
        routesBanner.style.display = 'block';
      }
    }

    function focusFirstActiveIncident() {
      if (activeIncidentsList && activeIncidentsList.length > 0) {
        const inc = activeIncidentsList[0];
        const coords = inc.blocked_segment?.coordinates;
        if (Array.isArray(coords) && coords.length > 0 && map) {
          map.setView(coords[0], 14, { animate: true });
          showToast(`Инцидент: ${inc.title || ''}`, '⚠️');
        }
      } else if (activeClosures && activeClosures.length > 0) {
        const bbox = activeClosures[0].blocked_segment?.coordinates_bbox;
        if (Array.isArray(bbox) && bbox.length > 0 && map) {
          map.setView(bbox[0], 14, { animate: true });
        }
      }
    }

    function renderClosuresOnMap() {
      if (blockedLayer && map) {
        map.removeLayer(blockedLayer);
        blockedLayer = null;
      }

      if (!activeClosures || activeClosures.length === 0) return;

      blockedLayer = L.featureGroup().addTo(map);

      activeClosures.forEach(c => {
        let bbox = c.blocked_geometry || c.blocked_segment?.coordinates_bbox;
        if (!Array.isArray(bbox) || bbox.length < 2) {
          const tKey = `${c.closure_id || ''} ${c.detour_preset_id || ''} ${c.blocked_segment?.title || ''} ${c.passenger_alert?.title || ''} ${c.passenger_alert?.message || ''}`.toLowerCase();
          const matchedTpl = findClientDetourTemplate(tKey);
          if (matchedTpl) {
            bbox = matchedTpl.blocked_segment?.coordinates;
            c.blocked_geometry = bbox;
          }
        }
        if (!Array.isArray(bbox) || bbox.length < 2) return;

        const snappedBlocked = (typeof buildTrackSnappedPath === 'function')
          ? buildTrackSnappedPath(bbox)
          : bbox;

        const dirMeta = (window.UETClosures?.getClosureDirectionMeta)
          ? window.UETClosures.getClosureDirectionMeta(c.direction || c.blocked_segment?.direction)
          : {
              key: 'both',
              label: 'Движение закрыто В ОБЕ СТОРОНЫ',
              shortLabel: 'В оба направления',
              icon: '🔄',
              badge: '🔄 В оба направления',
              color: '#ef4444',
              bgClass: 'bg-rose-950/90',
              borderClass: 'border-rose-500/60',
              textClass: 'text-rose-300'
            };

        const popupContent = (window.UETClosures?.buildIncidentPopupHtml)
          ? window.UETClosures.buildIncidentPopupHtml(c, escapeHtml)
          : `
            <div class="space-y-1.5 p-1 min-w-[220px]">
              <div class="flex items-center justify-between gap-1 border-b border-slate-800 pb-1">
                <span class="text-xs font-bold text-rose-400">⛔ ПЕРЕКРЫТИЕ ПУТЕЙ</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-950 border border-rose-600 text-rose-300 font-bold">${dirMeta.icon} ${dirMeta.shortLabel}</span>
              </div>
              <div class="text-xs text-white font-bold">${escapeHtml(c.passenger_alert?.title || 'Перекрытый участок')}</div>
              <div class="text-[11px] text-amber-300 font-semibold">${dirMeta.icon} ${dirMeta.label}</div>
              <div class="text-[11px] text-slate-200 leading-snug">${escapeHtml(c.passenger_alert?.message || '')}</div>
              <div class="text-[10px] text-amber-300 font-mono mt-1">Маршруты: ${(c.affected_routes || []).join(', ')}</div>
            </div>
          `;

        // 1. Наружный пульсирующий ореол
        L.polyline(snappedBlocked, {
          color: '#ef4444',
          weight: 12,
          opacity: 0.35,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'pulsing-blocked-segment-glow',
          interactive: false
        }).addTo(blockedLayer);

        // 2. Основная насыщенная красная линия
        const polyline = L.polyline(snappedBlocked, {
          color: '#dc2626',
          weight: 6,
          opacity: 0.98,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'pulsing-blocked-segment'
        }).addTo(blockedLayer);
        polyline.bindPopup(popupContent);

        // 3. Внутренняя контрастная пунктирная нить
        L.polyline(snappedBlocked, {
          color: '#ffffff',
          weight: 2,
          dashArray: '6, 6',
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false
        }).addTo(blockedLayer);

        // 4. Плавающий бейдж направления по центру отрезка
        const midIdx = Math.floor(snappedBlocked.length / 2);
        const centerPt = snappedBlocked[midIdx];
        const dirBadgeIcon = L.divIcon({
          className: 'closure-direction-badge',
          html: `
            <div class="px-2.5 py-1 rounded-full ${dirMeta.bgClass} text-white border ${dirMeta.borderClass} shadow-2xl flex items-center gap-1.5 text-[11px] font-bold tracking-tight select-none cursor-pointer hover:scale-105 transition-transform ring-2 ring-rose-500/30 whitespace-nowrap">
              <span class="text-rose-400 font-black">⛔</span>
              <span>${escapeHtml(dirMeta.badge)}</span>
            </div>
          `,
          iconAnchor: [60, 14]
        });
        L.marker(centerPt, { icon: dirBadgeIcon, zIndexOffset: 2500 })
          .addTo(blockedLayer)
          .bindPopup(popupContent);

        // 5. Концевые маркеры ⛔
        [snappedBlocked[0], snappedBlocked[snappedBlocked.length - 1]].forEach(pt => {
          const stopIcon = L.divIcon({
            className: 'closure-marker-wrapper',
            html: '<div style="background:#dc2626; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; border:2px solid #fff; box-shadow:0 0 10px rgba(220,38,38,0.9); cursor:pointer;">⛔</div>',
            iconSize: [22, 22],
            iconAnchor: [11, 11]
          });
          L.marker(pt, { icon: stopIcon, zIndexOffset: 2400 })
            .addTo(blockedLayer)
            .bindPopup(popupContent);
        });
      });
    }

    function updateTopClosureBanner() {
      const banner = document.getElementById('closures-alert-banner');
      if (!banner) return;

      if (!activeClosures || activeClosures.length === 0) {
        banner.classList.add('hidden');
        banner.style.display = 'none';
        return;
      }

      // Берем первое или самое важное активное предупреждение
      const first = activeClosures[0];
      const alert = first.passenger_alert || {};
      const routesStr = (first.affected_routes || []).join(', ');

      const titleEl = document.getElementById('closures-banner-title');
      const msgEl = document.getElementById('closures-banner-message');
      if (titleEl) titleEl.textContent = alert.title || `Внимание: закрытие путей (№ ${routesStr})`;
      if (msgEl) msgEl.textContent = alert.message || 'Движение временно изменено. См. схему объезда.';
      banner.classList.remove('hidden');
      banner.style.display = 'block';
    }

    function dismissClosureBanner() {
      const banner = document.getElementById('closures-alert-banner');
      if (banner) {
        banner.classList.add('hidden');
        banner.style.display = 'none';
      }
    }

    function clearRouteSelection() {
      selectRoute('all');
    }

    function onRouteSelect(val) {
      selectRoute(val);
    }

    let currentPublicDirection = 'both'; // 'both' | 'direct' | 'return'

    function toggleRouteDirection() {
      if (currentPublicDirection === 'both') {
        currentPublicDirection = 'direct';
      } else if (currentPublicDirection === 'direct') {
        currentPublicDirection = 'return';
      } else {
        currentPublicDirection = 'both';
      }
      updatePublicDirectionUI();
    }

    function updatePublicDirectionUI() {
      const icon = document.getElementById('header-dir-icon');
      const label = document.getElementById('header-dir-label');
      const sheetIcon = document.getElementById('sheet-dir-icon');
      const sheetLabel = document.getElementById('sheet-dir-label');
      const iconChar = currentPublicDirection === 'direct' ? '➡️' : (currentPublicDirection === 'return' ? '⬅️' : '⇄');
      const labelText = currentPublicDirection === 'direct' ? 'Прямое' : (currentPublicDirection === 'return' ? 'Обратное' : 'Оба пути');

      if (icon) icon.textContent = iconChar;
      if (label) label.textContent = labelText;
      if (sheetIcon) sheetIcon.textContent = iconChar;
      if (sheetLabel) sheetLabel.textContent = labelText;

      const dirText = currentPublicDirection === 'direct' ? 'Прямое направление' : (currentPublicDirection === 'return' ? 'Обратное направление' : 'Оба направления');
      showToast(dirText, '⇄');
      if (activeSelectedRouteData) {
        renderSelectedRouteLayers(activeSelectedRouteData);
      }
    }

    // Переключение между сетями Трамваи / Троллейбусы
    function switchNetwork(type) {
      currentType = type;
      currentRouteId = 'all';

      // Кнопки в верхней плашке
      const headerTram = document.getElementById('header-btn-tram');
      const headerTrolley = document.getElementById('header-btn-trolley');
      if (headerTram && headerTrolley) {
        if (type === 'tram') {
          headerTram.className = 'h-10 px-3 rounded-xl text-xs font-bold transition-all bg-amber-500 text-slate-950 shadow-md flex items-center gap-1.5 cursor-pointer';
          headerTrolley.className = 'h-10 px-3 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer';
        } else {
          headerTrolley.className = 'h-10 px-3 rounded-xl text-xs font-bold transition-all bg-emerald-500 text-slate-950 shadow-md flex items-center gap-1.5 cursor-pointer';
          headerTram.className = 'h-10 px-3 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer';
        }
      }

      // Кнопки в сайдбаре / шторке
      const sideTram = document.getElementById('sidebar-net-tram');
      const sideTrolley = document.getElementById('sidebar-net-trolley');
      if (sideTram && sideTrolley) {
        if (type === 'tram') {
          sideTram.className = 'py-2 rounded-xl text-xs font-bold transition-all bg-amber-500 text-slate-950 shadow-md flex items-center justify-center gap-1.5 cursor-pointer';
          sideTrolley.className = 'py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer';
        } else {
          sideTrolley.className = 'py-2 rounded-xl text-xs font-bold transition-all bg-emerald-500 text-slate-950 shadow-md flex items-center justify-center gap-1.5 cursor-pointer';
          sideTram.className = 'py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer';
        }
      }

      // Обновляем эмодзи в компактном баре шторки
      const compactEmoji = document.getElementById('compact-network-emoji');
      if (compactEmoji) {
        compactEmoji.textContent = (type === 'tram') ? '🚊' : '🚎';
      }
      if (type === 'tram') {
        if (map) map.setView([54.3188, 48.3977], 12, { animate: true });
      } else {
        if (map) map.setView([54.377, 48.587], 12, { animate: true });
      }

      updateCompactSheetBar();
      loadInfrastructure(type);
      loadRoutes();
      loadActiveClosures();
    }

    // Управление состоянием нижней шторки (Peek, Half, Expanded)
    let currentSheetState = 'collapsed'; // 'collapsed' | 'half' | 'expanded'

    function setBottomSheetState(state) {
      currentSheetState = state;
      const sidebar = document.getElementById('sidebar-panel');
      if (!sidebar) return;

      sidebar.classList.remove('sheet-collapsed', 'sheet-half', 'sheet-expanded');
      sidebar.classList.add(`sheet-${state}`);

      const chevron = document.getElementById('sheet-chevron-icon');
      if (chevron) {
        if (state === 'collapsed') chevron.textContent = '⌃';
        else if (state === 'half') chevron.textContent = '⌃';
        else chevron.textContent = '⌄';
      }

      setTimeout(() => { if (map) map.invalidateSize(); }, 360);
    }

    function cycleBottomSheetState() {
      if (window.innerWidth >= 768) return;
      if (currentSheetState === 'collapsed') {
        setBottomSheetState('half');
      } else if (currentSheetState === 'half') {
        setBottomSheetState('expanded');
      } else {
        setBottomSheetState('collapsed');
      }
    }

    function initBottomSheetGestures() {
      const handle = document.getElementById('sheet-handle-bar');
      const sidebar = document.getElementById('sidebar-panel');
      if (!handle || !sidebar) return;

      let startY = 0;
      let currentY = 0;
      let isDragging = false;

      handle.addEventListener('touchstart', (e) => {
        if (window.innerWidth >= 768) return;
        startY = e.touches[0].clientY;
        currentY = startY;
        isDragging = true;
      }, { passive: true });

      handle.addEventListener('touchmove', (e) => {
        if (!isDragging || window.innerWidth >= 768) return;
        currentY = e.touches[0].clientY;
      }, { passive: true });

      handle.addEventListener('touchend', () => {
        if (!isDragging || window.innerWidth >= 768) return;
        isDragging = false;
        const diff = currentY - startY;
        if (diff < -35) {
          // Свайп вверх -> раскрываем
          if (currentSheetState === 'collapsed') {
            setBottomSheetState('half');
          } else if (currentSheetState === 'half') {
            setBottomSheetState('expanded');
          }
        } else if (diff > 35) {
          // Свайп вниз -> сворачиваем
          if (currentSheetState === 'expanded') {
            setBottomSheetState('half');
          } else if (currentSheetState === 'half') {
            setBottomSheetState('collapsed');
          }
        }
      });
    }

    function updateCompactSheetBar() {
      const titleEl = document.getElementById('sheet-compact-route-title');
      const subEl = document.getElementById('sheet-compact-route-sub');
      if (!titleEl) return;

      if (currentRouteId && currentRouteId !== 'all') {
        const r = allRoutes.find(x => x.uniqueId === currentRouteId || x.route_id === currentRouteId || String(x.route_id) === String(currentRouteId));
        const prefix = currentType === 'tram' ? 'Трамвай №' : 'Троллейбус №';
        const rNum = r ? (r.route_id || currentRouteId) : currentRouteId;
        titleEl.textContent = `${prefix} ${rNum}`;

        const stopsCount = activeSelectedRouteData?.directions?.direct?.stops?.length || 0;
        const isDetourActive = Boolean(activeSelectedRouteData?.is_detour_active || activeSelectedRouteData?.has_detour);
        if (subEl) {
          subEl.textContent = `🟢 Онлайн • ${stopsCount ? stopsCount + ' остановок' : 'Маршрут активен'}${isDetourActive ? ' • Объезд' : ''}`;
        }
      } else {
        titleEl.textContent = currentType === 'tram' ? 'Все трамвайные пути' : 'Все троллейбусные линии';
        if (subEl) {
          const routesCount = allRoutes.filter(r => r.transport_type === currentType).length;
          subEl.textContent = `🟢 Онлайн • ${routesCount ? routesCount + ' маршрутов' : 'Вся сеть'}`;
        }
      }
    }

    function locatePassengerPosition() {
      if (!navigator.geolocation) {
        showToast('Геолокация не поддерживается', '⚠️');
        return;
      }
      showToast('Определение местоположения...', '📍');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          if (map) {
            map.setView([lat, lng], 16, { animate: true });
            if (window.userLocationMarker) {
              map.removeLayer(window.userLocationMarker);
            }
            window.userLocationMarker = L.circleMarker([lat, lng], {
              radius: 9,
              fillColor: '#38bdf8',
              color: '#ffffff',
              weight: 3,
              opacity: 1,
              fillOpacity: 0.95
            }).addTo(map).bindPopup('<b class="text-xs">Вы находитесь здесь</b>').openPopup();
          }
          showToast('Координаты определены', '✓');
        },
        (err) => {
          showToast('Не удалось получить координаты', '⚠️');
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    }

    function togglePassengerMenuModal() {
      const modal = document.getElementById('passenger-menu-modal');
      if (modal) modal.classList.toggle('hidden');
    }

    function showToast(msg, icon = '✓') {
      const toast = document.getElementById('toast');
      const msgEl = document.getElementById('toast-msg');
      const iconEl = document.getElementById('toast-icon');
      if (!toast) return;
      if (msgEl) msgEl.textContent = msg;
      if (iconEl) iconEl.textContent = icon;
      toast.classList.remove('hidden');
      clearTimeout(window._toastTimeout);
      window._toastTimeout = setTimeout(() => { toast.classList.add('hidden'); }, 3000);
    }

    // Управление вкладками сайдбара
    function switchSidebarTab(tab) {
      const routesContent = document.getElementById('sidebar-tab-routes-content');
      const stopsContent = document.getElementById('sidebar-tab-stops-content');
      const tabBtnRoutes = document.getElementById('tab-btn-routes');
      const tabBtnStops = document.getElementById('tab-btn-stops');

      if (tab === 'routes') {
        routesContent.classList.remove('hidden');
        routesContent.classList.add('flex');
        stopsContent.classList.add('hidden');
        stopsContent.classList.remove('flex');
        tabBtnRoutes.classList.add('active');
        tabBtnStops.classList.remove('active');
      } else {
        stopsContent.classList.remove('hidden');
        stopsContent.classList.add('flex');
        routesContent.classList.add('hidden');
        routesContent.classList.remove('flex');
        tabBtnStops.classList.add('active');
        tabBtnRoutes.classList.remove('active');
      }
    }

    // Сворачивание боковой панели
    function toggleSidebarCollapse(forceCollapse) {
      if (window.innerWidth < 768) {
        cycleBottomSheetState();
        return;
      }
      const panel = document.getElementById('sidebar-panel');
      const floatBtn = document.getElementById('btn-floating-open-sidebar');
      const arrow = document.getElementById('sidebar-collapse-arrow');

      if (typeof forceCollapse === 'boolean') {
        isSidebarCollapsed = forceCollapse;
      } else {
        isSidebarCollapsed = !isSidebarCollapsed;
      }

      if (isSidebarCollapsed) {
        panel.classList.add('sidebar-collapsed');
        if (floatBtn) floatBtn.classList.remove('hidden');
        if (arrow) arrow.textContent = '▶';
      } else {
        panel.classList.remove('sidebar-collapsed');
        if (floatBtn) floatBtn.classList.add('hidden');
        if (arrow) arrow.textContent = '◀';
      }
      setTimeout(() => { if (map) map.invalidateSize(); }, 320);
    }

    function toggleSidebar() {
      if (window.innerWidth < 768) {
        cycleBottomSheetState();
      } else {
        toggleSidebarCollapse();
      }
    }

    // Фильтрация маршрутов и остановок
    function filterRoutesList(query) {
      const q = (query || '').toLowerCase().trim();
      const filtered = allRoutes.filter(r => {
        if (r.transport_type !== currentType) return false;
        if (!q) return true;
        return (r.title || '').toLowerCase().includes(q) || (r.route_id || '').toLowerCase().includes(q);
      });
      renderRoutesList(filtered);
    }

    function filterStopsList(query) {
      const q = (query || '').toLowerCase().trim();
      const filtered = currentStopsData.filter(f => {
        if (!q) return true;
        return (f.properties?.name || '').toLowerCase().includes(q);
      });
      renderStopsList(filtered);
    }

    // Быстрый поиск в шапке
    function onTopSearchInput(val) {
      const q = (val || '').toLowerCase().trim();
      const dropdown = document.getElementById('top-search-dropdown');
      const clearBtn = document.getElementById('top-search-clear');
      if (clearBtn) clearBtn.classList.toggle('hidden', !q);
      if (!dropdown) return;

      if (!q) {
        dropdown.classList.add('hidden');
        return;
      }

      const matched = currentStopsData.filter(f => (f.properties?.name || '').toLowerCase().includes(q)).slice(0, 8);
      if (matched.length === 0) {
        dropdown.innerHTML = '<div class="p-2 text-xs text-slate-500">Ничего не найдено</div>';
        dropdown.classList.remove('hidden');
        return;
      }

      dropdown.innerHTML = '';
      matched.forEach(f => {
        const name = f.properties?.name || 'Остановка';
        const coords = f.geometry?.coordinates;
        const div = document.createElement('div');
        div.className = 'p-2 rounded-xl hover:bg-slate-800 text-xs text-white cursor-pointer transition-colors';
        div.innerHTML = `📍 ${escapeHtml(name)}`;
        div.onclick = () => {
          if (coords) focusOnStop(name, [coords[1], coords[0]]);
          dropdown.classList.add('hidden');
        };
        dropdown.appendChild(div);
      });
      dropdown.classList.remove('hidden');
    }

    function clearTopSearch() {
      const inp = document.getElementById('top-search-input');
      if (inp) inp.value = '';
      const clearBtn = document.getElementById('top-search-clear');
      if (clearBtn) clearBtn.classList.add('hidden');
      const dropdown = document.getElementById('top-search-dropdown');
      if (dropdown) dropdown.classList.add('hidden');
    }

    // Переключение темы карты (инверсия OSM)
    function toggleMapTheme() {
      const mapDiv = document.getElementById('map');
      const icon = document.getElementById('theme-icon');
      isDarkTheme = !isDarkTheme;
      if (mapDiv) {
        mapDiv.classList.toggle('dark-tiles', isDarkTheme);
      }
      if (icon) {
        icon.textContent = isDarkTheme ? '🌙' : '☀️';
      }
    }

    function resetMapView() {
      if (map) {
        if (currentType === 'trolleybus') {
          map.setView([54.377, 48.587], 12, { animate: true });
        } else {
          map.setView([54.3188, 48.3977], 12, { animate: true });
        }
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ========================================================
    // ДИАГНОСТИКА СИСТЕМЫ И ПРОВЕРКА OFFLINE-КЭША
    // ========================================================
    function openDiagnosticsModal() {
      const modal = document.getElementById('diagnostics-modal');
      if (modal) modal.classList.remove('hidden');
      refreshDiagnosticsUI();
    }
    window.openDiagnosticsModal = openDiagnosticsModal;

    function closeDiagnosticsModal() {
      const modal = document.getElementById('diagnostics-modal');
      if (modal) modal.classList.add('hidden');
    }
    window.closeDiagnosticsModal = closeDiagnosticsModal;

    async function refreshDiagnosticsUI() {
      const isOnline = navigator.onLine;
      const netStatusEl = document.getElementById('diag-net-status');
      if (netStatusEl) {
        if (isOnline) {
          netStatusEl.textContent = 'Онлайн';
          netStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        } else {
          netStatusEl.textContent = 'Офлайн (работа из локальной памяти)';
          netStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30';
        }
      }

      const swStatusEl = document.getElementById('diag-sw-status');
      if (swStatusEl) {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          swStatusEl.textContent = 'Активен (v2.0)';
          swStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        } else if ('serviceWorker' in navigator) {
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            if (regs && regs.length > 0) {
              swStatusEl.textContent = 'Установлен (активен)';
              swStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
            } else {
              swStatusEl.textContent = 'Не установлен';
              swStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700';
            }
          } catch (e) {
            swStatusEl.textContent = 'Ошибка';
            swStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30';
          }
        } else {
          swStatusEl.textContent = 'Не поддерживается';
          swStatusEl.className = 'px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700';
        }
      }

      if (window.UETOfflineDB) {
        const stats = await window.UETOfflineDB.getStats();
        const routesEl = document.getElementById('diag-routes-count');
        const stopsEl = document.getElementById('diag-stops-count');
        const verEl = document.getElementById('diag-data-version');
        const syncEl = document.getElementById('diag-last-sync');

        if (routesEl) routesEl.textContent = stats.routes_count;
        if (stopsEl) stopsEl.textContent = stats.stops_count;
        if (verEl) verEl.textContent = stats.version && stats.version !== '—' ? 'v' + stats.version : 'Локальная';
        if (syncEl) syncEl.textContent = stats.last_sync || 'Не синхронизировано';
      }
    }

    async function runPingTest() {
      const resultDiv = document.getElementById('diag-ping-result');
      if (!resultDiv) return;

      resultDiv.classList.remove('hidden');
      resultDiv.className = 'p-2.5 rounded-2xl text-xs font-mono font-medium text-center bg-slate-800 text-sky-300 animate-pulse border border-slate-700';
      resultDiv.textContent = '⏳ Измерение ping к /api/v1/sync/status (таймаут 8с)...';

      const startTime = performance.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 секунд для мобильных вышек/БС

      try {
        const res = await fetch('/api/v1/sync/status?t=' + Date.now(), {
          signal: controller.signal,
          cache: 'no-cache'
        });
        clearTimeout(timeoutId);
        const latency = Math.round(performance.now() - startTime);

        if (res.ok) {
          resultDiv.className = 'p-2.5 rounded-2xl text-xs font-mono font-bold text-center bg-emerald-950/80 text-emerald-300 border border-emerald-500/50 shadow-lg';
          resultDiv.innerHTML = `[OK: ${latency}ms | Сервер доступен]`;
          updateOnlineBadge(true, `Онлайн (${latency}ms)`);
        } else {
          throw new Error('HTTP ' + res.status);
        }
      } catch (e) {
        clearTimeout(timeoutId);
        resultDiv.className = 'p-2.5 rounded-2xl text-xs font-mono font-bold text-center bg-amber-950/80 text-amber-300 border border-amber-500/50 shadow-lg leading-tight';
        resultDiv.innerHTML = `[Таймаут мобильной сети > 8с | Работа из IndexedDB продолжается штатно]`;
        updateOnlineBadge(false, 'Офлайн (локальная память)');
      }
      refreshDiagnosticsUI();
    }
    window.runPingTest = runPingTest;

    async function forcePurgeAndReload() {
      if (confirm('Принудительно очистить локальный кэш IndexedDB и память Service Worker и перезагрузить?')) {
        if (window.UETOfflineDB) {
          await window.UETOfflineDB.clearAll();
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const k of keys) {
            await caches.delete(k);
          }
        }
        window.location.reload();
      }
    }
    window.forcePurgeAndReload = forcePurgeAndReload;

    function updateOnlineBadge(isOnline, label) {
      const badge = document.getElementById('counter-badge');
      const dot = document.getElementById('header-net-dot');
      if (badge) {
        badge.textContent = label || (isOnline ? 'Online' : 'Offline');
        if (isOnline) {
          badge.className = 'text-[9px] sm:text-[10px] font-mono px-1.5 sm:px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold';
        } else {
          badge.className = 'text-[9px] sm:text-[10px] font-mono px-1.5 sm:px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold';
        }
      }
      if (dot) {
        dot.className = isOnline ? 'w-2 h-2 rounded-full bg-emerald-400' : 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
      }
    }

    // Фоновая синхронизация версии данных и наполнение IndexedDB
    async function startBackgroundSync() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch('/api/v1/sync/status', {
          signal: controller.signal,
          cache: 'no-cache'
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error('Status HTTP ' + res.status);
        const statusData = await res.json();
        const serverVer = statusData.version;
        const localVer = window.UETOfflineDB ? await window.UETOfflineDB.getMeta('data_version') : null;
        const stats = window.UETOfflineDB ? await window.UETOfflineDB.getStats() : null;

        updateOnlineBadge(true, `Онлайн (v${serverVer})`);

        // Если версия обновилась или хранилище IndexedDB пустое — делаем полный синк
        if (!localVer || String(serverVer) !== String(localVer) || !stats || stats.routes_count === 0 || stats.stops_count === 0) {
          console.log(`[Sync] Updating local IndexedDB cache to version ${serverVer}...`);
          const [tramTracksRes, trolleyTracksRes, tramStopsRes, trolleyStopsRes, tramRoutesRes, trolleyRoutesRes] = await Promise.all([
            apiFetch('/api/geo/tracks?type=tram').catch(() => null),
            apiFetch('/api/geo/tracks?type=trolleybus').catch(() => null),
            apiFetch('/api/geo/stops?type=tram').catch(() => null),
            apiFetch('/api/geo/stops?type=trolleybus').catch(() => null),
            apiFetch('/api/geo/routes?type=tram').catch(() => null),
            apiFetch('/api/geo/routes?type=trolleybus').catch(() => null)
          ]);

          if (tramTracksRes && tramTracksRes.ok) {
            const d = await tramTracksRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveTracks('tram', d);
            if (currentType === 'tram') renderTracksLayer(d, '#38bdf8');
          }
          if (trolleyTracksRes && trolleyTracksRes.ok) {
            const d = await trolleyTracksRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveTracks('trolleybus', d);
            if (currentType === 'trolleybus') renderTracksLayer(d, '#34d399');
          }
          if (tramStopsRes && tramStopsRes.ok) {
            const d = await tramStopsRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveStops('tram', d);
            if (currentType === 'tram') renderStopsLayer(d);
          }
          if (trolleyStopsRes && trolleyStopsRes.ok) {
            const d = await trolleyStopsRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveStops('trolleybus', d);
            if (currentType === 'trolleybus') renderStopsLayer(d);
          }
          if (tramRoutesRes && tramRoutesRes.ok) {
            const d = await tramRoutesRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveRoutes('tram', d);
            if (currentType === 'tram') renderRoutesUI(d);
          }
          if (trolleyRoutesRes && trolleyRoutesRes.ok) {
            const d = await trolleyRoutesRes.json();
            if (window.UETOfflineDB) await window.UETOfflineDB.saveRoutes('trolleybus', d);
            if (currentType === 'trolleybus') renderRoutesUI(d);
          }

          if (window.UETOfflineDB) {
            await window.UETOfflineDB.setMeta('data_version', serverVer);
            await window.UETOfflineDB.setMeta('timestamp_saved', Date.now());
            await window.UETOfflineDB.setMeta('last_sync_time', new Date().toLocaleString('ru-RU'));
          }
        } else {
          if (window.UETOfflineDB) {
            await window.UETOfflineDB.setMeta('last_sync_time', new Date().toLocaleString('ru-RU'));
          }
        }
        refreshDiagnosticsUI();
      } catch (err) {
        console.warn('[Sync] Offline or timeout (working from device memory):', err);
        updateOnlineBadge(false, 'Офлайн (кэш)');
        refreshDiagnosticsUI();
      }
    }

    // Слушатели изменения статуса сети
    window.addEventListener('online', () => {
      updateOnlineBadge(true, 'Онлайн');
      startBackgroundSync();
    });
    window.addEventListener('offline', () => {
      updateOnlineBadge(false, 'Офлайн (кэш)');
      refreshDiagnosticsUI();
    });

    // Запуск приложения: 1) мгновенная отрисовка из памяти 2) тихий фоновый синк
    document.addEventListener('DOMContentLoaded', async () => {
      initMap();
      initBottomSheetGestures();
      updateCompactSheetBar();
      await loadInfrastructure('tram');
      await loadRoutes();
      loadActiveClosures();
      initPassengerVehiclesTelemetry();

      // Тихий фоновый синк (таймаут 8с)
      startBackgroundSync();

      // Регистрация пассажирского Service Worker (Beta) с динамическим scope
      if ('serviceWorker' in navigator) {
        const swPath = window.location.pathname.startsWith('/map') ? '/map/sw_passenger_beta.js' : '/sw_passenger_beta.js';
        const swScope = window.location.pathname.startsWith('/map') ? '/map/' : '/';
        navigator.serviceWorker.register(swPath, { scope: swScope })
          .then(reg => {
            console.log('Passenger Beta SW registered:', reg.scope);
            reg.update().catch(() => {});
            setTimeout(refreshDiagnosticsUI, 500);
          })
          .catch(err => console.warn('Passenger Beta SW reg failed:', err));
      }

      setTimeout(refreshDiagnosticsUI, 600);
    });

    // ========================================================
    // ЖИВАЯ ТЕЛЕМЕТРИЯ ТРАНСПОРТА ДЛЯ ПАССАЖИРОВ
    // ========================================================
    window.passengerVehiclesCache = {};
    window.passengerVehicleMarkers = {};
    let passengerVehiclesTimer = null;
    let passengerVehiclesWs = null;

    function initPassengerVehiclesTelemetry() {
      if (!window.passengerVehiclesLayer && map) {
        window.passengerVehiclesLayer = L.layerGroup().addTo(map);
      }
      pollPassengerVehicles();
      if (passengerVehiclesTimer) clearInterval(passengerVehiclesTimer);
      passengerVehiclesTimer = setInterval(pollPassengerVehicles, 2500);
      initPassengerWebSocket();
    }

    function initPassengerWebSocket() {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/ws/telemetry`;
        passengerVehiclesWs = new WebSocket(wsUrl);
        passengerVehiclesWs.onmessage = (ev) => {
          try {
            window.lastPassengerWsMessageTime = Date.now();
            const msg = JSON.parse(ev.data);
            if (msg.event === 'VEHICLES_TELEMETRY' && Array.isArray(msg.vehicles)) {
              // Исключаем служебные, депо и скрытые диспетчером
              const publicList = msg.vehicles.filter(v => 
                !v.hide_from_public && 
                v.status !== 'service' && 
                v.status !== 'depot' &&
                v.route_id !== 'Служебный' &&
                v.route_id !== 'В депо' &&
                v.route_id !== 'Буксир'
              );
              renderPassengerVehicles(publicList);
            }
            if (msg.event === 'INCIDENT_UPDATED' || msg.event === 'INCIDENT_RESOLVED' || msg.event === 'ALERT_NEW' || msg.event === 'ALERT_DISMISSED' || msg.event === 'CLOSURE_RESOLVED') {
              if (msg.event === 'INCIDENT_RESOLVED' || msg.event === 'CLOSURE_RESOLVED') {
                showReopenedCelebrationBanner(msg.title, msg.affected_routes);
              }
              loadActiveClosures();
            }
          } catch (e) {}
        };
        passengerVehiclesWs.onerror = () => {};
        passengerVehiclesWs.onclose = () => {
          setTimeout(initPassengerWebSocket, 10000);
        };
      } catch (e) {}
    }

    // Периодический опрос инцидентов и перекрытий (каждые 10 секунд)
    setInterval(loadActiveClosures, 10000);

    // Кэш предыдущих позиций и углов для плавного сохранения курса
    window.passengerPrevPositions = {};
    window.passengerPrevBearings = {};

    // Плавная интерполяция движения (LERP) без конфликтов с Leaflet transform при зуме
    function animateMarkerLerp(marker, targetLatLng, durationMs) {
      if (!marker || !targetLatLng) return;
      const startLatLng = marker.getLatLng();
      const startLat = startLatLng.lat;
      const startLng = startLatLng.lng;
      const targetLat = targetLatLng[0];
      const targetLng = targetLatLng[1];

      // Если смещение минимально или отсутствует — ставим мгновенно
      const dLat = targetLat - startLat;
      const dLng = targetLng - startLng;
      if (Math.abs(dLat) < 0.000001 && Math.abs(dLng) < 0.000001) {
        marker.setLatLng(targetLatLng);
        return;
      }

      if (marker._animFrameId) {
        cancelAnimationFrame(marker._animFrameId);
        marker._animFrameId = null;
      }

      const startTime = performance.now();
      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / durationMs, 1);
        const curLat = startLat + dLat * progress;
        const curLng = startLng + dLng * progress;
        marker.setLatLng([curLat, curLng]);

        if (progress < 1) {
          marker._animFrameId = requestAnimationFrame(step);
        } else {
          marker._animFrameId = null;
        }
      }
      marker._animFrameId = requestAnimationFrame(step);
    }

    function calculateBearingAngle(lat1, lon1, lat2, lon2) {
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const rLat1 = lat1 * Math.PI / 180;
      const rLat2 = lat2 * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(rLat2);
      const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
      let brng = Math.atan2(y, x) * 180 / Math.PI;
      return (brng + 360) % 360;
    }

    async function pollPassengerVehicles() {
      // Если WebSocket активен и шлет кадры, отменяем лишние HTTP-запросы
      if (passengerVehiclesWs && passengerVehiclesWs.readyState === WebSocket.OPEN) {
        if (Date.now() - (window.lastPassengerWsMessageTime || 0) < 6000) {
          return;
        }
      }
      try {
        const res = await apiFetch('/api/vehicles');
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            // Строгая клиентская фильтрация для абсолютной гарантии
            const filtered = list.filter(v => 
              !v.hide_from_public && 
              v.status !== 'service' && 
              v.status !== 'depot' &&
              v.route_id !== 'Служебный' &&
              v.route_id !== 'В депо' &&
              v.route_id !== 'Буксир'
            );
            renderPassengerVehicles(filtered);
          }
        }
      } catch (e) {
        console.warn('pollPassengerVehicles error:', e);
      }
    }

    function renderPassengerVehicles(vehicles) {
      if (!window.passengerVehiclesLayer || !map) return;
      window.latestPassengerVehicles = vehicles;

      const activeIds = new Set();

      // Фильтрация:
      // 1) По типу транспорта (currentType: 'tram' или 'trolleybus')
      // 2) По выбранному маршруту: если currentRouteId === 'all', отображаются вагоны ВСЕХ маршрутов!
      let targetRouteNum = null;
      if (currentRouteId && currentRouteId !== 'all') {
        const parts = String(currentRouteId).split('_');
        targetRouteNum = parts.length > 1 ? parts[1] : parts[0];
      }

      vehicles.forEach(v => {
        if (!v || !v.id || typeof v.lat !== 'number' || typeof v.lon !== 'number') return;

        // Фильтр по виду транспорта
        if (v.transport_type && v.transport_type !== currentType) {
          return;
        }

        // Фильтр по конкретному выбранному маршруту (если не 'all')
        if (targetRouteNum !== null) {
          const vRouteNum = String(v.route_number || v.route_id || '').trim();
          if (vRouteNum !== targetRouteNum) {
            return;
          }
        }

        activeIds.add(v.id);
        window.passengerVehiclesCache[v.id] = v;

        // Расчет или сохранение угла движения (bearing)
        let bearing = 0;
        if (typeof v.bearing === 'number' && !isNaN(v.bearing) && v.bearing !== 0) {
          bearing = v.bearing;
        } else if (window.passengerPrevPositions[v.id]) {
          const prev = window.passengerPrevPositions[v.id];
          const dist = Math.hypot(v.lat - prev.lat, v.lon - prev.lon);
          if (dist > 0.00005) {
            bearing = calculateBearingAngle(prev.lat, prev.lon, v.lat, v.lon);
          } else {
            bearing = window.passengerPrevBearings[v.id] || 0;
          }
        } else {
          bearing = window.passengerPrevBearings[v.id] || 0;
        }

        window.passengerPrevPositions[v.id] = { lat: v.lat, lon: v.lon };
        window.passengerPrevBearings[v.id] = bearing;

        const isTrolley = (v.transport_type === 'trolleybus');
        const iconSymbol = isTrolley ? '🚎' : '🚊';
        const pillClass = isTrolley ? 'trolley' : '';

        // Бейдж модели («Львенок», «Татра», «Адмирал»)
        let shortModel = v.model || '';
        if (shortModel.includes('Львенок')) shortModel = 'Львенок';
        else if (shortModel.includes('Tatra') || shortModel.includes('Татра')) shortModel = 'Татра';
        else if (shortModel.includes('Адмирал')) shortModel = 'Адмирал';
        else if (shortModel.includes('БКМ')) shortModel = 'БКМ';
        else if (shortModel.includes('ЗиУ')) shortModel = 'ЗиУ';

        const lowFloorBadge = v.low_floor ? '<span class="text-emerald-400 text-[10px]">♿</span>' : '';

        const html = `
          <div class="passenger-veh-marker">
            <div class="passenger-veh-dot-wrapper">
              <div class="passenger-veh-pointer-ring" style="transform: rotate(${Math.round(bearing)}deg);">
                <div class="passenger-veh-pointer-arrow ${pillClass}"></div>
              </div>
              <div class="passenger-veh-dot ${pillClass}" title="Маршрут № ${v.route_number || v.route_id}">
                ${v.route_number || v.route_id}
              </div>
            </div>
            ${shortModel ? `<span class="passenger-veh-model-badge ${pillClass}">${shortModel}</span>` : ''}
          </div>
        `;

        const icon = L.divIcon({
          className: 'passenger-veh-divicon',
          html: html,
          iconSize: [48, 48],
          iconAnchor: [24, 24]
        });

        const popupContent = buildPassengerVehiclePopup(v, isTrolley, shortModel);

        if (window.passengerVehicleMarkers[v.id]) {
          const marker = window.passengerVehicleMarkers[v.id];
          animateMarkerLerp(marker, [v.lat, v.lon], 1600);
          marker.setIcon(icon);
          const popup = marker.getPopup();
          if (!popup || !popup.isOpen()) {
            marker.setPopupContent(popupContent);
          }
        } else {
          // zIndexOffset: 1000 гарантирует отображение выше путей и остановок
          const marker = L.marker([v.lat, v.lon], { icon: icon, zIndexOffset: 1000 }).addTo(window.passengerVehiclesLayer);
          marker.bindPopup(popupContent, { maxWidth: 280, minWidth: 220, className: 'dark-popup' });
          window.passengerVehicleMarkers[v.id] = marker;
        }
      });

      // Удаление скрытых, отфильтрованных или ушедших с линии вагонов
      Object.keys(window.passengerVehicleMarkers).forEach(id => {
        if (!activeIds.has(id)) {
          const marker = window.passengerVehicleMarkers[id];
          if (marker && marker._animFrameId) {
            cancelAnimationFrame(marker._animFrameId);
            marker._animFrameId = null;
          }
          window.passengerVehiclesLayer.removeLayer(marker);
          delete window.passengerVehicleMarkers[id];
        }
      });
    }

    function buildPassengerVehiclePopup(v, isTrolley, shortModel) {
      const typeTitle = isTrolley ? 'Троллейбус' : 'Трамвай';
      const dirTitle = v.direction === 'direct' ? '➡️ Прямое направление' : '⬅️ Обратное направление';
      const pillBg = isTrolley ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30';

      return `
        <div class="p-3 space-y-2.5 min-w-[220px]">
          <div class="flex items-center justify-between pb-2 border-b border-slate-700/80">
            <div class="flex items-center gap-1.5">
              <span class="text-base">${isTrolley ? '🚎' : '🚊'}</span>
              <div>
                <div class="font-extrabold text-white text-xs">${typeTitle} № ${v.route_number || v.route_id}</div>
                <div class="text-[10px] text-slate-400">${dirTitle}</div>
              </div>
            </div>
            <span class="text-[10px] font-mono px-2 py-0.5 rounded-full ${pillBg} border font-bold">
              В пути
            </span>
          </div>

          <div class="space-y-1.5 text-xs">
            <div class="flex justify-between text-slate-300">
              <span class="text-slate-400">Модель:</span>
              <span class="font-bold text-white">${v.model || shortModel || '—'}</span>
            </div>
            <div class="flex justify-between text-slate-300">
              <span class="text-slate-400">Доступность:</span>
              <span class="font-bold ${v.low_floor ? 'text-emerald-400' : 'text-slate-400'}">
                ${v.low_floor ? '♿ Низкий пол (пандус)' : 'Стандартный вход'}
              </span>
            </div>
            <div class="flex justify-between text-slate-300">
              <span class="text-slate-400">Скорость:</span>
              <span class="font-mono font-bold text-amber-300">${Math.round(v.speed || 0)} км/ч</span>
            </div>
          </div>
          <div class="text-[9px] text-slate-400 pt-1 border-t border-slate-800 text-center">
            Движение по расписанию МУП «УЭТ»
          </div>
        </div>
      `;
    }