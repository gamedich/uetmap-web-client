// ==========================================
// 6. ui_controls.js: Управление интерфейсом, маршрутами и вкладками
// ==========================================
(function() {
  try {
    let currentSidebarTab = 'stops';
    let isSidebarCollapsed = window.innerWidth < 768;
    let dismissedAlertIds = new Set(JSON.parse(localStorage.getItem('uet_dismissed_alerts') || '[]'));

    window.populateRouteSelector = function() {
      try {
        const tramsGroup = document.getElementById('opt-trams');
        const trolleysGroup = document.getElementById('opt-trolleys');
        if (!tramsGroup || !trolleysGroup) return;

        tramsGroup.innerHTML = '';
        trolleysGroup.innerHTML = '';

        (window.routes || []).forEach(r => {
          const isBlocked = typeof window.isRouteAffectedByIncident === 'function' ? window.isRouteAffectedByIncident(r.number) : false;
          const statusIcon = isBlocked ? '⛔' : '🟢';
          const opt = document.createElement('option');
          opt.value = r.id;
          opt.textContent = `${statusIcon} № ${r.number} — ${r.name}`;
          if (r.type === 'tram') {
            tramsGroup.appendChild(opt);
          } else {
            trolleysGroup.appendChild(opt);
          }
        });
      } catch (e) {
        console.error('[ui_controls.js] populateRouteSelector error:', e);
      }
    };

    window.selectRoute = function(routeInput) {
      try {
        if (!routeInput || String(routeInput).toLowerCase() === 'all' || routeInput === 'Все') {
          window.clearRouteSelection();
          return;
        }

        const cleanNum = String(routeInput).replace(/^[Тт][Рр]?/, '').trim();
        let matchedRoute = (window.routes || []).find(r => String(r.number).trim() === cleanNum);
        if (!matchedRoute) {
          matchedRoute = (window.routes || []).find(r => String(r.id) === String(routeInput) || String(r.number).trim().toLowerCase() === cleanNum.toLowerCase());
        }

        const routeId = matchedRoute ? matchedRoute.id : cleanNum;
        window.selectedRouteId = routeId;

        const selectEl = document.getElementById('route-select');
        if (selectEl) {
          selectEl.value = matchedRoute ? matchedRoute.id : 'all';
        }

        document.querySelectorAll('.route-pill-btn').forEach(btn => btn.classList.remove('active'));
        const rawInputPill = document.getElementById(`pill-${routeInput}`);
        const cleanPillT = document.getElementById(`pill-Т${cleanNum}`);
        const cleanPillTr = document.getElementById(`pill-Тр${cleanNum}`);
        if (rawInputPill) rawInputPill.classList.add('active');
        else if (cleanPillT) cleanPillT.classList.add('active');
        else if (cleanPillTr) cleanPillTr.classList.add('active');

        if (typeof window.renderRoutes === 'function') window.renderRoutes();
        if (typeof window.renderMarkers === 'function') window.renderMarkers();
        if (typeof window.renderSidebarList === 'function') window.renderSidebarList();
        if (typeof window.updateVehiclesVisibility === 'function') window.updateVehiclesVisibility();

        window.updateBottomRouteStatus(cleanNum, matchedRoute);
        window.zoomToSelectedRoute(cleanNum, matchedRoute);
      } catch (err) {
        console.error('[ui_controls.js] selectRoute error:', err);
      }
    };

    window.zoomToSelectedRoute = function(cleanNum, matchedRoute) {
      try {
        if (!window.map) return;
        const bounds = L.latLngBounds([]);

        const matchedSegments = (window.trackSegmentsList || []).filter(seg => {
          if (!seg.routes) return false;
          return seg.routes.map(String).includes(cleanNum);
        });

        matchedSegments.forEach(seg => {
          if (seg.coordinates && seg.coordinates.length > 0) {
            seg.coordinates.forEach(c => bounds.extend(c));
          }
        });

        if (matchedRoute && matchedRoute.poly_coordinates && matchedRoute.poly_coordinates.length > 0) {
          matchedRoute.poly_coordinates.forEach(c => bounds.extend(c));
        }

        (window.points || []).forEach(pt => {
          const routesList = (pt.route || '').split(',').map(s => s.trim());
          if (routesList.includes(cleanNum) && pt.coords) {
            bounds.extend([pt.coords[0], pt.coords[1]]);
          }
        });

        if (bounds.isValid()) {
          window.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
        }
      } catch (e) {
        console.error('zoomToSelectedRoute error:', e);
      }
    };

    window.updateBottomRouteStatus = function(cleanNum, matchedRoute) {
      try {
        const bottomBanner = document.getElementById('route-bottom-banner');
        const bottomIcon = document.getElementById('route-bottom-icon');
        const bottomTitle = document.getElementById('route-bottom-title');
        const bottomStatus = document.getElementById('route-bottom-status');
        if (!bottomBanner) return;

        const isTrolley = matchedRoute ? matchedRoute.type === 'trolley' : ['6', '12', '14'].includes(cleanNum);
        const vehicleTypeName = isTrolley ? 'Троллейбус' : 'Трамвай';
        const iconEmoji = isTrolley ? '🚎' : '🚋';
        const routeName = matchedRoute ? matchedRoute.name : `Маршрут №${cleanNum}`;

        bottomIcon.textContent = iconEmoji;
        bottomTitle.textContent = `${vehicleTypeName} №${cleanNum} (${routeName})`;

        const matchedSegments = (window.trackSegmentsList || []).filter(seg => {
          if (!seg.routes) return false;
          return seg.routes.map(String).includes(cleanNum);
        });

        const activeClosure = (window.closuresList || []).find(c => {
          if (c.status !== 'active') return false;
          const segMatch = matchedSegments.some(s => s.id === c.segment_id);
          if (segMatch) return true;
          const aff = c.routes_affected || [];
          if (Array.isArray(aff)) return aff.map(String).includes(cleanNum);
          return String(aff).includes(cleanNum);
        });

        if (activeClosure) {
          const closedSeg = matchedSegments.find(s => s.id === activeClosure.segment_id);
          const segName = closedSeg ? closedSeg.name : (activeClosure.title || 'ул. Радищева');
          const detour = activeClosure.detour_text ? ` (${activeClosure.detour_text})` : '';
          bottomStatus.className = 'text-[11px] sm:text-xs font-bold text-rose-400 flex items-center gap-1.5 mt-0.5';
          bottomStatus.innerHTML = `<span>🔴 Внимание: перекрыт участок ${window.escapeHtml(segName)}${window.escapeHtml(detour)}</span>`;
        } else {
          bottomStatus.className = 'text-[11px] sm:text-xs font-semibold text-emerald-400 flex items-center gap-1.5 mt-0.5';
          bottomStatus.innerHTML = `<span>🟢 Движение штатное</span>`;
        }

        bottomBanner.classList.remove('hidden');
      } catch (e) {
        console.error('updateBottomRouteStatus error:', e);
      }
    };

    window.onRouteSelect = function(val) {
      if (val === 'all') {
        window.clearRouteSelection();
      } else {
        const r = (window.routes || []).find(item => item.id === val);
        if (r) {
          window.selectRoute(r.number);
        } else {
          window.selectRoute(val);
        }
      }
    };

    window.clearRouteSelection = function() {
      window.selectedRouteId = 'all';
      const selectEl = document.getElementById('route-select');
      if (selectEl) selectEl.value = 'all';

      document.querySelectorAll('.route-pill-btn').forEach(btn => btn.classList.remove('active'));
      const pillAll = document.getElementById('pill-all');
      if (pillAll) pillAll.classList.add('active');

      const bottomBanner = document.getElementById('route-bottom-banner');
      if (bottomBanner) bottomBanner.classList.add('hidden');

      const card = document.getElementById('route-info-card');
      if (card) card.classList.add('hidden');

      if (typeof window.renderRoutes === 'function') window.renderRoutes();
      if (typeof window.renderMarkers === 'function') window.renderMarkers();
      if (typeof window.renderSidebarList === 'function') window.renderSidebarList();
      if (typeof window.updateVehiclesVisibility === 'function') window.updateVehiclesVisibility();
    };

    window.renderSidebarList = function() {
      try {
        const container = document.getElementById('points-list');
        if (!container) return;
        const filtered = typeof window.getFilteredPoints === 'function' ? window.getFilteredPoints() : (window.points || []);

        const statEl = document.getElementById('filtered-stat');
        if (statEl) statEl.textContent = `Показано: ${filtered.length} из ${(window.points || []).length}`;

        if (filtered.length === 0) {
          container.innerHTML = `
            <div class="text-center py-12 text-slate-500 space-y-2">
              <div class="text-2xl">🔍</div>
              <p class="text-xs">Остановки не найдены</p>
            </div>
          `;
          return;
        }

        const TYPE_META = window.TYPE_META;
        container.innerHTML = filtered.map(pt => {
          const meta = TYPE_META[pt.type] || TYPE_META.tram;
          const color = pt.color || meta.defaultColor;

          return `
            <div class="group p-2.5 rounded-2xl bg-slate-900/90 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/80 transition-all flex items-center justify-between gap-2.5 cursor-pointer" onclick="focusOnPoint('${pt.id}')">
              <div class="flex items-center gap-2.5 min-w-0 flex-1">
                <div class="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center text-sm shadow-sm" style="background:${color}22; border:1px solid ${color}44; color:${color}">
                  ${meta.icon}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-semibold text-white truncate group-hover:text-amber-300 transition-colors">${window.escapeHtml(pt.name)}</div>
                  <div class="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                    ${pt.route ? `<span class="text-amber-400/90 font-mono">№ ${window.escapeHtml(pt.route)}</span>` : '<span class="text-slate-500">Остановка сети</span>'}
                  </div>
                </div>
              </div>
              <span class="text-slate-500 text-xs">➔</span>
            </div>
          `;
        }).join('');
      } catch (e) {
        console.error('[ui_controls.js] renderSidebarList error:', e);
      }
    };

    window.setFilterType = function(type) {
      if (typeof window.haptic === 'function') window.haptic('selection');
      window.activeFilter = type;
      document.querySelectorAll('.filter-tab').forEach(btn => {
        btn.className = 'filter-tab px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800/60 text-slate-400 hover:text-slate-200 border border-slate-800 text-center transition-all';
      });
      const activeBtn = document.getElementById(`tab-${type}`);
      if (activeBtn) {
        activeBtn.className = 'filter-tab px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 text-center transition-all';
      }
      if (typeof window.renderMarkers === 'function') window.renderMarkers();
      if (typeof window.renderRoutes === 'function') window.renderRoutes();
      if (typeof window.updateVehiclesVisibility === 'function') window.updateVehiclesVisibility();
      window.renderSidebarList();
    };

    window.applyFilters = function() {
      if (typeof window.haptic === 'function') window.haptic('light');
      if (typeof window.renderMarkers === 'function') window.renderMarkers();
      window.renderSidebarList();
    };

    window.focusOnPoint = function(id) {
      if (typeof window.haptic === 'function') window.haptic('light');
      const pt = (window.points || []).find(p => p.id === id);
      if (!pt || !window.map) return;
      window.map.flyTo(pt.coords, 16, { duration: 1.1 });
      const marker = window.markerInstances ? window.markerInstances[id] : null;
      if (marker && window.markersCluster) {
        setTimeout(() => {
          window.markersCluster.zoomToShowLayer(marker, () => {
            marker.openPopup();
          });
        }, 700);
      }
      if (window.innerWidth < 640) window.toggleSidebar(false);
      window.clearTopSearch();
    };

    window.onTopSearchInput = function(query) {
      const q = (query || '').toLowerCase().trim();
      const dropdown = document.getElementById('top-search-dropdown');
      const clearBtn = document.getElementById('top-search-clear');
      if (!dropdown) return;

      if (!q) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        return;
      }
      if (clearBtn) clearBtn.classList.remove('hidden');

      const matches = (window.points || []).filter(p => {
        return (p.name || '').toLowerCase().includes(q) ||
               (p.route || '').toLowerCase().includes(q) ||
               (p.desc || '').toLowerCase().includes(q);
      }).slice(0, 8);

      if (matches.length === 0) {
        dropdown.innerHTML = `<div class="px-3 py-2 text-center text-slate-400 text-xs">Остановки не найдены</div>`;
        dropdown.classList.remove('hidden');
        return;
      }

      const TYPE_META = window.TYPE_META;
      dropdown.innerHTML = matches.map(pt => {
        const meta = TYPE_META[pt.type] || TYPE_META.tram;
        return `
          <div onclick="focusOnPoint('${pt.id}')" class="px-2.5 py-1.5 rounded-xl hover:bg-slate-800 flex items-center justify-between gap-2 cursor-pointer transition-all">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs shrink-0">${meta.icon}</span>
              <span class="text-xs font-semibold text-white truncate">${window.escapeHtml(pt.name)}</span>
            </div>
            ${pt.route ? `<span class="text-[10px] font-mono text-amber-300 font-bold shrink-0">№ ${window.escapeHtml(pt.route)}</span>` : ''}
          </div>
        `;
      }).join('');
      dropdown.classList.remove('hidden');
    };

    window.clearTopSearch = function() {
      const input = document.getElementById('top-search-input');
      const dropdown = document.getElementById('top-search-dropdown');
      const clearBtn = document.getElementById('top-search-clear');
      if (input) input.value = '';
      if (dropdown) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
      }
      if (clearBtn) clearBtn.classList.add('hidden');
    };

    window.resetMapView = function() {
      if (window.map) window.map.flyTo([54.3188, 48.3977], 13, { duration: 1.0 });
    };

    window.toggleLabelsVisibility = function() {
      window.resetMapView();
    };

    window.toggleMapTheme = function() {
      window.isDarkTheme = !window.isDarkTheme;
      const mapDiv = document.getElementById('map');
      const icon = document.getElementById('theme-icon');
      if (window.isDarkTheme) {
        if (mapDiv) mapDiv.classList.add('dark-tiles');
        if (icon) icon.textContent = '🌙';
      } else {
        if (mapDiv) mapDiv.classList.remove('dark-tiles');
        if (icon) icon.textContent = '☀️';
      }
    };

    // Сворачивание и разворачивание боковой панели
    window.initSidebarState = function() {
      if (isSidebarCollapsed) {
        window.collapseSidebar(true, false);
      } else {
        window.collapseSidebar(false, false);
      }
    };

    window.toggleSidebarCollapse = function(forceCollapse) {
      const willCollapse = typeof forceCollapse === 'boolean' ? forceCollapse : !isSidebarCollapsed;
      window.collapseSidebar(willCollapse, true);
    };

    window.toggleSidebar = function(forceState) {
      if (typeof forceState === 'boolean') {
        window.collapseSidebar(!forceState, true);
      } else {
        window.toggleSidebarCollapse();
      }
    };

    window.collapseSidebar = function(collapsed, animate) {
      isSidebarCollapsed = !!collapsed;
      const panel = document.getElementById('sidebar-panel');
      const arrow = document.getElementById('sidebar-collapse-arrow');
      const floatBtn = document.getElementById('btn-floating-open-sidebar');
      const mobBar = document.getElementById('mobile-bottom-bar');

      if (!panel) return;

      if (isSidebarCollapsed) {
        panel.classList.add('sidebar-collapsed');
        if (arrow) arrow.textContent = '▶';
        if (floatBtn) {
          floatBtn.classList.remove('hidden');
          floatBtn.classList.add('flex');
        }
        if (mobBar) mobBar.classList.remove('hidden');
      } else {
        panel.classList.remove('sidebar-collapsed');
        if (arrow) arrow.textContent = '◀';
        if (floatBtn) {
          floatBtn.classList.add('hidden');
          floatBtn.classList.remove('flex');
        }
        if (mobBar) mobBar.classList.add('hidden');
      }
    };

    // Вкладки: Остановки и Маршруты
    window.switchSidebarTab = function(tab) {
      currentSidebarTab = tab;
      const stopsBtn = document.getElementById('tab-btn-stops');
      const routesBtn = document.getElementById('tab-btn-routes');
      const stopsContent = document.getElementById('sidebar-tab-stops-content');
      const routesContent = document.getElementById('sidebar-tab-routes-content');

      if (tab === 'stops') {
        if (stopsBtn) stopsBtn.classList.add('active');
        if (routesBtn) routesBtn.classList.remove('active');
        if (stopsContent) stopsContent.classList.remove('hidden');
        if (routesContent) routesContent.classList.add('hidden');
      } else {
        if (routesBtn) routesBtn.classList.add('active');
        if (stopsBtn) stopsBtn.classList.remove('active');
        if (routesContent) routesContent.classList.remove('hidden');
        if (stopsContent) stopsContent.classList.add('hidden');
        window.renderRoutesCatalog();
      }
    };

    window.renderRoutesCatalog = function() {
      const container = document.getElementById('routes-catalog-list');
      if (!container) return;

      const q = (document.getElementById('routes-search-input')?.value || '').toLowerCase().trim();
      const defaultTramNumbers = ['1', '4', '5', '6', '9', '10', '11', '15', '19', '22', '22К'];
      const defaultTrolleyNumbers = ['1', '2', '3', '5', '6', '11', '12', '14', '15', '18'];
      const allCatalog = [];

      defaultTramNumbers.forEach(num => {
        const dbRoute = (window.routes || []).find(r => r.type === 'tram' && String(r.number).trim().toUpperCase() === num.toUpperCase());
        allCatalog.push({
          type: 'tram',
          number: num,
          name: dbRoute ? dbRoute.name : `Трамвай № ${num}`,
          id: dbRoute ? dbRoute.id : `tram_${num}`
        });
      });

      defaultTrolleyNumbers.forEach(num => {
        const dbRoute = (window.routes || []).find(r => r.type === 'trolley' && String(r.number).trim() === num);
        allCatalog.push({
          type: 'trolley',
          number: num,
          name: dbRoute ? dbRoute.name : `Троллейбус № ${num}`,
          id: dbRoute ? dbRoute.id : `trolley_${num}`
        });
      });

      const filtered = allCatalog.filter(item => {
        if (!q) return true;
        return item.number.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
      });

      if (filtered.length === 0) {
        container.innerHTML = `
          <div class="text-center py-8 text-slate-500 space-y-1">
            <div class="text-xl">🔍</div>
            <p class="text-xs">Маршрут не найден</p>
          </div>
        `;
        return;
      }

      container.innerHTML = filtered.map(item => {
        const numStr = String(item.number).trim();
        const selectedRouteId = window.selectedRouteId;
        const isSelected = selectedRouteId === item.id || selectedRouteId === numStr || (selectedRouteId && selectedRouteId.replace(/^[Тт][Рр]?/, '').trim() === numStr);
        const isBlocked = typeof window.isRouteAffectedByIncident === 'function' ? window.isRouteAffectedByIncident(numStr) : false;

        let blockedSegName = '';
        if (isBlocked) {
          const closure = (window.closuresList || []).find(c => {
            if (c.status !== 'active') return false;
            const aff = Array.isArray(c.routes_affected) ? c.routes_affected.map(String) : [];
            return aff.includes(numStr);
          });
          blockedSegName = closure ? (closure.title || closure.segment_id || 'Радищева') : 'Радищева';
          if (blockedSegName.includes('Радищева')) blockedSegName = 'Радищева';
        }

        const isTram = item.type === 'tram';
        const badgeColor = isTram ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30';
        const typeIcon = isTram ? '🚋' : '🚎';

        return `
          <div onclick="onSelectCatalogRoute('${window.escapeHtml(item.number)}', '${window.escapeHtml(item.id)}')" class="p-2.5 rounded-2xl ${isSelected ? 'bg-amber-500/15 border-amber-500/50 ring-1 ring-amber-500/30' : 'bg-slate-900/90 border-slate-800/80 hover:bg-slate-800/80 hover:border-slate-700'} border transition-all flex items-center justify-between gap-2.5 cursor-pointer group">
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <div class="w-9 h-9 rounded-xl shrink-0 flex items-center justify-center font-bold text-xs border ${badgeColor}">
                ${typeIcon} ${window.escapeHtml(item.number)}
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-bold ${isSelected ? 'text-amber-300' : 'text-white'} truncate group-hover:text-amber-300 transition-colors">
                  ${window.escapeHtml(item.name)}
                </div>
                <div class="flex items-center gap-1.5 text-[10px] mt-0.5">
                  ${isBlocked ? `
                    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-rose-950/80 border border-rose-800/60 text-rose-300 font-bold">
                      <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                      🔴 Изменен (${window.escapeHtml(blockedSegName)})
                    </span>
                  ` : `
                    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-800/40 text-emerald-300 font-semibold">
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                      🟢 В движении
                    </span>
                  `}
                </div>
              </div>
            </div>
            <span class="text-slate-500 text-xs shrink-0 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all">➔</span>
          </div>
        `;
      }).join('');
    };

    window.onSelectCatalogRoute = function(num, id) {
      window.selectRoute(num);
      if (window.innerWidth < 640) {
        window.toggleSidebarCollapse(true);
      }
    };

    window.updateCounter = function() {
      const points = window.points || [];
      const txt = `${points.length} ост.`;
      const counterEl = document.getElementById('counter-badge');
      if (counterEl) counterEl.textContent = txt;
      const mobBadge = document.getElementById('mobile-badge');
      if (mobBadge) mobBadge.textContent = points.length;
    };

    // Оповещения
    window.fetchAlerts = async function() {
      try {
        const res = await fetch('/map/api/alerts?active=1');
        if (res.ok) {
          window.alerts = await res.json();
          window.updateAlertsBadge();
        }
      } catch (e) {
        console.error('[ui_controls.js] fetchAlerts error:', e);
      }
    };

    window.getVisibleAlerts = function() {
      return (window.alerts || []).filter(a => a.is_active && !dismissedAlertIds.has(a.id));
    };

    window.dismissAlert = function(alertId, e) {
      if (e) e.stopPropagation();
      dismissedAlertIds.add(alertId);
      localStorage.setItem('uet_dismissed_alerts', JSON.stringify(Array.from(dismissedAlertIds)));
      window.updateAlertsBadge();
      window.renderAlertsList();
      window.showToast('Оповещение скрыто');
    };

    window.dismissAllAlerts = function() {
      (window.alerts || []).forEach(a => dismissedAlertIds.add(a.id));
      localStorage.setItem('uet_dismissed_alerts', JSON.stringify(Array.from(dismissedAlertIds)));
      window.updateAlertsBadge();
      window.renderAlertsList();
      window.showToast('Все оповещения очищены');
    };

    window.updateAlertsBadge = function() {
      const activeAlerts = window.getVisibleAlerts();
      const badge = document.getElementById('alerts-badge');
      const modalCount = document.getElementById('alerts-modal-count');
      const btn = document.getElementById('btn-top-alerts');

      if (badge) {
        badge.textContent = activeAlerts.length;
        if (activeAlerts.length > 0) {
          badge.classList.remove('hidden');
          badge.classList.add('flex');
          if (btn) btn.classList.add('border-amber-500/50', 'bg-amber-500/10');
        } else {
          badge.classList.add('hidden');
          badge.classList.remove('flex');
          if (btn) btn.classList.remove('border-amber-500/50', 'bg-amber-500/10');
        }
      }
      if (modalCount) {
        modalCount.textContent = `${activeAlerts.length} активных`;
      }
    };

    window.openAlertsModal = function() {
      window.renderAlertsList();
      document.getElementById('alerts-modal')?.classList.remove('hidden');
    };

    window.closeAlertsModal = function() {
      document.getElementById('alerts-modal')?.classList.add('hidden');
    };

    window.renderAlertsList = function() {
      const container = document.getElementById('alerts-list-container');
      if (!container) return;
      const activeList = window.getVisibleAlerts();

      if (!activeList || activeList.length === 0) {
        container.innerHTML = `
          <div class="text-center py-10 text-slate-400 space-y-2">
            <div class="text-3xl">✅</div>
            <p class="text-xs font-semibold text-white">Все линии работают в штатном режиме</p>
            <p class="text-[11px] text-slate-500">Нет активных или непрочитанных перекрытий и задержек</p>
          </div>
        `;
        return;
      }

      container.innerHTML = activeList.map(a => {
        const isActive = a.is_active;
        const isDanger = a.severity === 'danger' || a.type === 'emergency';
        const isWarning = a.severity === 'warning' || a.type === 'maintenance';

        let badgeColor = 'bg-slate-800 text-slate-400 border-slate-700';
        let statusText = 'Архивное сообщение';
        let icon = 'ℹ️';

        if (isActive) {
          if (isDanger) {
            badgeColor = 'bg-rose-500/20 text-rose-300 border-rose-500/40';
            statusText = 'Движение перекрыто';
            icon = '⛔';
          } else if (isWarning) {
            badgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
            statusText = 'Ремонт / Задержка';
            icon = '⚠️';
          } else {
            badgeColor = 'bg-blue-500/20 text-blue-300 border-blue-500/40';
            statusText = 'Внимание пассажирам';
            icon = '📢';
          }
        } else {
          badgeColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
          statusText = 'Движение открыто';
          icon = '🟢';
        }

        const dateStr = a.created_at ? new Date(a.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

        return `
          <div class="p-3 rounded-2xl ${isActive ? 'bg-slate-950/90 border border-slate-800/80 shadow-md' : 'bg-slate-950/40 opacity-70'} space-y-1.5 transition-all">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="text-base">${icon}</span>
                <span class="text-xs font-bold text-white">${window.escapeHtml(a.title)}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-mono border ${badgeColor} whitespace-nowrap">${statusText}</span>
                <button type="button" onclick="dismissAlert('${window.escapeHtml(a.id)}', event)" title="Скрыть оповещение" class="p-1 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-white transition-all text-xs leading-none">✕</button>
              </div>
            </div>

            <p class="text-xs text-slate-300 leading-relaxed">${window.escapeHtml(a.message || 'Нет описания')}</p>

            <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-800/40 mt-1">
              ${a.affected_routes ? `<span class="text-amber-400 font-mono font-semibold">Маршруты: ${window.escapeHtml(a.affected_routes)}</span>` : '<span></span>'}
              <div class="flex items-center gap-2">
                <span>${dateStr}</span>
                <button type="button" onclick="dismissAlert('${window.escapeHtml(a.id)}', event)" class="text-amber-400 hover:text-amber-300 font-medium text-[10px] underline underline-offset-2">Скрыть</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    };

    window.fetchEvents = async function() {
      try {
        const res = await fetch('/map/api/events');
        if (res.ok) window.events = await res.json();
      } catch (e) {
        console.warn('fetchEvents notice:', e);
      }
    };

    // Тост
    let toastTimeout = null;
    window.showToast = function(msg, icon = '✓') {
      const toast = document.getElementById('toast');
      const iconEl = document.getElementById('toast-icon');
      const msgEl = document.getElementById('toast-msg');
      if (!toast) return;

      if (iconEl) iconEl.textContent = icon;
      if (msgEl) msgEl.textContent = msg;

      toast.classList.remove('hidden');
      if (toastTimeout) clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
      }, 3000);
    };

    // Авторизация администратора
    window.openAdminAuthModal = function() {
      const pass = document.getElementById('admin-password-input');
      if (pass) pass.value = '';
      document.getElementById('auth-error-msg')?.classList.add('hidden');
      document.getElementById('admin-auth-modal')?.classList.remove('hidden');
      setTimeout(() => pass?.focus(), 100);
    };

    window.closeAdminAuthModal = function() {
      document.getElementById('admin-auth-modal')?.classList.add('hidden');
    };

    window.submitAdminLogin = async function(e) {
      if (e) e.preventDefault();
      const pass = document.getElementById('admin-password-input')?.value;
      const errEl = document.getElementById('auth-error-msg');
      if (errEl) errEl.classList.add('hidden');

      try {
        const res = await fetch('/map/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        if (data.ok) {
          localStorage.setItem('uet_admin_token', data.token);
          window.location.href = '/map/admin';
        } else {
          if (errEl) {
            errEl.textContent = data.error || 'Неверный пароль';
            errEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = 'Ошибка связи с сервером';
          errEl.classList.remove('hidden');
        }
      }
    };

    // PWA Установка
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = document.getElementById('pwa-install-btn');
      if (btn) btn.classList.remove('opacity-60');
    });

    window.openInstallModal = function() {
      document.getElementById('install-modal')?.classList.remove('hidden');
    };

    window.closeInstallModal = function() {
      document.getElementById('install-modal')?.classList.add('hidden');
      if (window.location.hash === '#install') {
        history.replaceState(null, null, ' ');
      }
    };

    window.triggerPwaInstall = async function() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          window.showToast('Приложение установлено на экран!');
          window.closeInstallModal();
        }
        deferredPrompt = null;
      } else {
        alert('Для установки на Android:\n1. Нажмите на меню браузера (три точки ⋮ вверху справа)\n2. Выберите «Установить приложение» или «Добавить на главный экран»');
      }
    };

    // Главная функция запуска приложения
    window.initApp = async function() {
      try {
        // 1. Инициализируем карту и группы слоев
        if (typeof window.initMap === 'function') {
          window.initMap();
        }

        // 2. Инициализируем UI сайдбара
        window.initSidebarState();

        // 3. Загружаем маршруты
        if (typeof window.fetchRoutes === 'function') {
          await window.fetchRoutes();
        }

        // 4. Загружаем параллельно остановки, инциденты, закрытия, сегменты и алерты
        await Promise.all([
          typeof window.fetchPoints === 'function' ? window.fetchPoints() : null,
          typeof window.fetchEvents === 'function' ? window.fetchEvents() : null,
          typeof window.fetchAlerts === 'function' ? window.fetchAlerts() : null,
          typeof window.fetchIncidents === 'function' ? window.fetchIncidents() : null,
          typeof window.fetchClosures === 'function' ? window.fetchClosures() : null,
          typeof window.fetchTrackSegments === 'function' ? window.fetchTrackSegments() : null
        ]);

        // 5. Запуск симуляции движения вагонов
        if (typeof window.initVehicleSimulation === 'function') {
          window.initVehicleSimulation();
        }

        // 6. Подключение WebSocket и регулярного опроса
        if (typeof window.initTelemetryWebSocket === 'function') {
          window.initTelemetryWebSocket();
        }
        if (typeof window.syncVehiclesState === 'function') {
          setInterval(window.syncVehiclesState, 15000);
        }

        if (window.location.hash === '#install') {
          setTimeout(window.openInstallModal, 400);
        }

        console.log('[ui_controls.js] App successfully booted in modular architecture');
      } catch (err) {
        console.error('[ui_controls.js] Error during initApp:', err);
      }
    };

    window.addEventListener('DOMContentLoaded', window.initApp);
  } catch (globalErr) {
    console.error('Global error in ui_controls.js:', globalErr);
  }
})();
