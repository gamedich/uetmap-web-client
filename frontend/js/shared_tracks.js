// ==========================================
// 2. shared_tracks.js: Загрузка постоянной геометрии путей и подсветка маршрутов
// ==========================================
(function() {
  try {
    window.tramTracksGeo = null;
    window.trolleyTracksGeo = null;
    window.baseTracksLayer = null;

    // Загрузка эталонных списков маршрутов
    window.fetchRoutes = async function() {
      try {
        let res = await fetch('/map/api/routes').catch(() => null);
        if (!res || !res.ok) res = await fetch('/api/routes').catch(() => null);
        if (res && res.ok) {
          window.routes = await res.json();
          if (typeof window.populateRouteSelector === 'function') {
            window.populateRouteSelector();
          }
          if (!window.tramTracksGeo && typeof window.fetchBaseTracksGeo === 'function') {
            await window.fetchBaseTracksGeo();
          } else {
            window.renderRoutes();
          }
        }
      } catch (e) {
        console.error('[shared_tracks.js] Failed to fetch routes:', e);
      }
    };

    // Загрузка сегментов путей (если есть разметка сегментов)
    window.fetchTrackSegments = async function() {
      try {
        let res = await fetch('/map/api/track_segments').catch(() => null);
        if (!res || !res.ok) res = await fetch('/api/track_segments').catch(() => null);
        if (res && res.ok) {
          const data = await res.json();
          window.trackSegmentsList = data.segments || (Array.isArray(data) ? data : []);
          window.renderRoutes();
        }
      } catch (e) {
        console.error('[shared_tracks.js] Failed to fetch track segments:', e);
      }
    };

    // Загрузка полной физической геометрии рельсовой и контактной сети
    window.fetchBaseTracksGeo = async function() {
      try {
        const [tramRes, trolleyRes] = await Promise.all([
          fetch('/map/api/geo/tracks?type=tram').catch(() => null),
          fetch('/map/api/geo/tracks?type=trolleybus').catch(() => null)
        ]);

        if (tramRes && tramRes.ok) {
          window.tramTracksGeo = await tramRes.json();
        }
        if (trolleyRes && trolleyRes.ok) {
          window.trolleyTracksGeo = await trolleyRes.json();
        }

        window.renderBaseTracks();
      } catch (e) {
        console.error('[shared_tracks.js] Failed to load base tracks GeoJSON:', e);
      }
    };

    // Отрисовка постоянной инфраструктурной сетки путей
    window.renderBaseTracks = function() {
      try {
        if (!window.map) return;
        if (!window.baseTracksGroup) {
          window.baseTracksGroup = L.featureGroup().addTo(window.map);
          // Отправляем базовые пути на задний план под маркеры и транспорт
          if (window.baseTracksGroup.bringToBack) {
            window.baseTracksGroup.bringToBack();
          }
        }
        window.baseTracksGroup.clearLayers();

        const activeFilter = window.activeFilter || 'all';

        // 1. Трамвайные пути (аккуратная темно-серая/стальная рельсовая колея)
        if (window.tramTracksGeo && (activeFilter === 'all' || activeFilter === 'tram')) {
          L.geoJSON(window.tramTracksGeo, {
            style: {
              color: '#475569',
              weight: 3.5,
              opacity: 0.75,
              lineCap: 'round',
              lineJoin: 'round'
            }
          }).addTo(window.baseTracksGroup);

          // Внутренняя рельсовая нить
          L.geoJSON(window.tramTracksGeo, {
            style: {
              color: '#38bdf8',
              weight: 1.5,
              opacity: 0.6,
              dashArray: '6, 6'
            }
          }).addTo(window.baseTracksGroup);
        }

        // 2. Троллейбусная контактная сеть
        if (window.trolleyTracksGeo && (activeFilter === 'all' || activeFilter === 'trolley')) {
          L.geoJSON(window.trolleyTracksGeo, {
            style: {
              color: '#0d9488',
              weight: 2.5,
              opacity: 0.6,
              dashArray: '4, 4'
            }
          }).addTo(window.baseTracksGroup);
        }

        if (window.baseTracksGroup.bringToBack) {
          window.baseTracksGroup.bringToBack();
        }
      } catch (err) {
        console.error('[shared_tracks.js] Error in renderBaseTracks:', err);
      }
    };

    // Отрисовка активных маршрутов поверх путей
    window.renderRoutes = function() {
      try {
        if (!window.tracksGroup) return;
        window.tracksGroup.clearLayers();

        if (typeof window.renderClosures === 'function') {
          window.renderClosures();
        }

        const selectedRouteId = window.selectedRouteId || 'all';
        const routes = window.routes || [];
        const trackSegmentsList = window.trackSegmentsList || [];
        const closuresList = window.closuresList || [];

        // 1. Если выбран конкретный маршрут:
        if (selectedRouteId !== 'all') {
          const r = routes.find(item => String(item.id) === String(selectedRouteId) || String(item.number) === String(selectedRouteId));
          const routeNumStr = r ? String(r.number).trim() : String(selectedRouteId).replace(/^[Тт][Рр]?/, '').trim();

          const matchedSegments = trackSegmentsList.filter(seg => {
            if (!seg.routes) return false;
            return seg.routes.map(String).includes(routeNumStr);
          });

          // Подсвечиваем размеченные сегменты физических путей
          if (matchedSegments.length > 0) {
            matchedSegments.forEach(seg => {
              if (!seg.coordinates || seg.coordinates.length < 2) return;

              const activeClosure = closuresList.find(c => {
                if (c.status !== 'active') return false;
                return c.segment_id && c.segment_id === seg.id;
              });

              if (activeClosure) {
                // КРАСНЫЙ пунктир для перекрытого участка
                const closedPoly = L.polyline(seg.coordinates, {
                  color: '#ef4444',
                  weight: 7,
                  opacity: 0.95,
                  dashArray: '10, 10',
                  lineCap: 'round',
                  lineJoin: 'round',
                  className: 'pulsing-blocked-segment'
                }).addTo(window.tracksGroup);

                closedPoly.bindPopup(`
                  <div class="space-y-1.5 p-1 min-w-[220px]">
                    <div class="flex items-center gap-1.5 font-bold text-rose-400 text-xs border-b border-slate-800 pb-1">
                      <span>⚠️ ЗАКРЫТЫЙ УЧАСТОК ПУТЕЙ</span>
                    </div>
                    <div class="text-xs text-white font-bold">${window.escapeHtml(seg.name || activeClosure.title || seg.id)}</div>
                    <div class="text-[11px] text-amber-300 font-semibold">Причина: ${window.escapeHtml(activeClosure.reason || 'Ремонт / ДТП')}</div>
                  </div>
                `);
              } else {
                // Яркая подсветка движения по путям
                const freePoly = L.polyline(seg.coordinates, {
                  color: r && r.type === 'trolley' ? '#06b6d4' : '#3b82f6',
                  weight: 6,
                  opacity: 0.95,
                  lineCap: 'round',
                  lineJoin: 'round'
                }).addTo(window.tracksGroup);

                freePoly.bindTooltip(`№ ${routeNumStr}: ${seg.name}`, {
                  sticky: true,
                  className: 'bg-slate-900 text-white text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-700 shadow-xl'
                });
              }
            });
          }
          // КАТЕГОРИЧЕСКИЙ ЗАПРЕТ: не соединять остановки прямыми линиями по воздуху!
          // Фоновые пути уже отображаются в window.baseTracksGroup, а остановки подсвечиваются точечными маркерами.
        }

        // Обновляем базовые пути с учетом фильтра
        window.renderBaseTracks();
      } catch (err) {
        console.error('[shared_tracks.js] Error in renderRoutes:', err);
      }
    };
  } catch (globalErr) {
    console.error('Global error in shared_tracks.js:', globalErr);
  }
})();
