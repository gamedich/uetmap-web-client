// ==========================================
// 5. closures_layer.js: Загрузка и отрисовка перекрытий путей
// ==========================================
(function() {
  try {
    window.fetchClosures = async function() {
      try {
        const res = await fetch('/map/api/closures');
        if (res.ok) {
          window.closuresList = await res.json();
          window.renderClosures();
          if (typeof window.renderRoutes === 'function') {
            window.renderRoutes();
          }
        }
      } catch (e) {
        console.warn('[closures_layer.js] Failed to fetch closures (isolated):', e);
      }
    };

    window.fetchIncidents = async function() {
      try {
        const res = await fetch('/map/api/incidents?status=ACTIVE');
        if (res.ok) {
          window.incidents = await res.json();
          window.renderClosures();
          if (typeof window.populateRouteSelector === 'function') window.populateRouteSelector();
          if (typeof window.renderRoutes === 'function') window.renderRoutes();
          if (typeof window.renderMarkers === 'function') window.renderMarkers();
        }
      } catch (e) {
        console.warn('[closures_layer.js] Failed to fetch incidents (isolated):', e);
      }
    };

    window.isRouteAffectedByIncident = function(routeNumber) {
      try {
        const numStr = String(routeNumber).trim();
        return (window.incidents || []).some(inc => {
          if (inc.status !== 'ACTIVE') return false;
          const aff = inc.affected_routes || [];
          if (Array.isArray(aff)) {
            return aff.some(r => String(r).trim() === numStr || String(r).trim().toLowerCase() === 'все');
          }
          if (typeof aff === 'string') {
            return aff.toLowerCase().includes('все') || aff.split(',').map(s => s.trim()).includes(numStr);
          }
          return false;
        });
      } catch (e) {
        return false;
      }
    };

    window.renderClosures = function() {
      try {
        if (!window.closuresGroup) return;
        window.closuresGroup.clearLayers();

        const closuresList = window.closuresList || [];
        const incidents = window.incidents || [];

        // 1. Отображение закрытий участков путей
        closuresList.forEach(c => {
          if (c.status !== 'active') return;
          if (!c.coordinates || c.coordinates.length < 2) return;

          // Красный пунктир (#ef4444, толщина 7, dashArray 10, 10)
          const poly = L.polyline(c.coordinates, {
            color: '#ef4444',
            weight: 7,
            opacity: 0.95,
            dashArray: '10, 10',
            lineCap: 'round',
            lineJoin: 'round',
            className: 'pulsing-blocked-segment'
          }).addTo(window.closuresGroup);

          const routesAff = Array.isArray(c.routes_affected) ? c.routes_affected.join(', ') : (c.routes_affected || 'Все');
          const popupContent = `
            <div class="space-y-1.5 p-1 min-w-[220px]">
              <div class="flex items-center gap-1.5 font-bold text-rose-400 text-xs border-b border-slate-800 pb-1">
                <span>⚠️ ЗАКРЫТИЕ ДВИЖЕНИЯ</span>
              </div>
              <div class="text-xs text-white font-bold">${window.escapeHtml(c.title || c.segment_id || 'Участок путей')}</div>
              <div class="text-[11px] text-amber-300 font-semibold">Затронуты маршруты: № ${window.escapeHtml(routesAff)}</div>
              <div class="text-[11px] text-slate-300"><span class="text-slate-400">Причина:</span> ${window.escapeHtml(c.reason || 'Ремонтные работы / инцидент')}</div>
              <div class="text-[10px] text-slate-400 font-mono">Время: ${window.escapeHtml(c.start_time || '')} — ${window.escapeHtml(c.estimated_end || 'до окончания работ')}</div>
              ${c.detour_text ? `
                <div class="text-[11px] text-emerald-400 bg-emerald-950/40 p-1.5 rounded-lg border border-emerald-800/40 mt-1">
                  <span class="font-bold">Схема объезда:</span> ${window.escapeHtml(c.detour_text)}
                </div>
              ` : ''}
            </div>
          `;
          poly.bindPopup(popupContent);

          // Маркер ⚠️ в центре отрезка
          const midIdx = Math.floor(c.coordinates.length / 2);
          let centerPoint = c.coordinates[midIdx];
          if (c.coordinates.length % 2 === 0 && c.coordinates.length >= 2) {
            const p1 = c.coordinates[midIdx - 1];
            const p2 = c.coordinates[midIdx];
            centerPoint = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
          }

          const warningIcon = L.divIcon({
            className: 'custom-closure-warning-marker',
            html: `
              <div class="w-8 h-8 rounded-full bg-rose-600/90 text-white flex items-center justify-center text-sm shadow-lg border-2 border-white ring-2 ring-rose-500/40 cursor-pointer">
                ⚠️
              </div>
            `,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
          });

          const marker = L.marker(centerPoint, { icon: warningIcon, zIndexOffset: 2000 }).addTo(window.closuresGroup);
          marker.bindPopup(popupContent);
        });

        // 2. Отображение активных инцидентов и объездов
        incidents.forEach(inc => {
          if (inc.status !== 'ACTIVE') return;

          if (inc.blocked_segment && inc.blocked_segment.coordinates && inc.blocked_segment.coordinates.length > 1) {
            const isMaint = inc.severity === 'warning' || (inc.title && inc.title.toLowerCase().includes('ремонт'));
            const segColor = isMaint ? '#f59e0b' : '#ef4444';
            const segDash = isMaint ? '6, 6' : '10, 10';

            const blockedPoly = L.polyline(inc.blocked_segment.coordinates, {
              color: segColor,
              weight: 7,
              opacity: 0.95,
              dashArray: segDash,
              lineCap: 'round',
              lineJoin: 'round',
              className: 'pulsing-blocked-segment'
            }).addTo(window.closuresGroup);

            blockedPoly.bindPopup(`
              <div class="space-y-1">
                <div class="flex items-center gap-1.5 font-bold ${isMaint ? 'text-amber-400' : 'text-rose-400'} text-xs">
                  <span>${isMaint ? '🟡 РЕМОНТНЫЕ РАБОТЫ' : '⛔ ЗАКРЫТЫЙ УЧАСТОК ПУТЕЙ'}</span>
                </div>
                <p class="text-xs text-white font-medium">${window.escapeHtml(inc.title)}</p>
                <div class="text-[11px] text-slate-300">${window.escapeHtml(inc.announcement_text || '')}</div>
                <div class="text-[10px] text-amber-400 font-mono mt-1">Затронуты: № ${(inc.affected_routes || []).join(', ')}</div>
              </div>
            `);
          }

          if (inc.detour_path && inc.detour_path.coordinates && inc.detour_path.coordinates.length > 1) {
            const detourPoly = L.polyline(inc.detour_path.coordinates, {
              color: '#FB8C00',
              weight: 5,
              opacity: 0.9,
              dashArray: '8, 8',
              lineCap: 'round'
            }).addTo(window.closuresGroup);

            detourPoly.bindPopup(`
              <div class="space-y-1">
                <div class="flex items-center gap-1.5 font-bold text-amber-400 text-xs">
                  <span>⚡ СХЕМА ОБЪЕЗДА ВАГОНОВ</span>
                </div>
                <div class="text-xs text-white">${window.escapeHtml(inc.announcement_text || '')}</div>
                <div class="text-[10px] text-slate-400 font-mono mt-1">Маршруты: ${(inc.affected_routes || []).join(', ')}</div>
              </div>
            `);
          }
        });
      } catch (err) {
        console.warn('[closures_layer.js] Error in renderClosures (isolated):', err);
      }
    };
  } catch (globalErr) {
    console.error('Global error in closures_layer.js:', globalErr);
  }
})();
