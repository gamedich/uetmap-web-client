/**
 * Модуль управления инцидентами, перекрытиями путей и схемами объездов (UETMap Closures Controller).
 * - Определение направления перекрытия (в обе стороны / в одну сторону)
 * - Формирование стилей для заблокированных участков (насыщенная красная линия со свечением)
 * - Формирование стилей для путей временного объезда (янтарная линия)
 * - Плавающие индикаторы направления на карте и информационные всплывающие окна
 */

/**
 * Получение метаданных направления перекрытия
 * @param {string} dir
 * @returns {Object} { key, label, shortLabel, icon, badge, color, bgClass, borderClass }
 */
export function getClosureDirectionMeta(dir) {
  const d = String(dir || '').trim().toLowerCase();
  if (d === 'direct' || d === 'forward' || d === 'fwd') {
    return {
      key: 'direct',
      label: 'Закрыто только в ПРЯМОМ направлении',
      shortLabel: 'Прямое направление',
      icon: '➡️',
      badge: '➡️ Прямое направление',
      color: '#f59e0b',
      bgClass: 'bg-amber-950/80',
      borderClass: 'border-amber-500/60',
      textClass: 'text-amber-300'
    };
  }
  if (d === 'return' || d === 'reverse' || d === 'backward' || d === 'bwd') {
    return {
      key: 'return',
      label: 'Закрыто только в ОБРАТНОМ направлении',
      shortLabel: 'Обратное направление',
      icon: '⬅️',
      badge: '⬅️ Обратное направление',
      color: '#f59e0b',
      bgClass: 'bg-amber-950/80',
      borderClass: 'border-amber-500/60',
      textClass: 'text-amber-300'
    };
  }
  return {
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
}

/**
 * Наружный слой пульсирующего свечения для перекрытия
 */
export function getBlockedSegmentGlowStyle() {
  return {
    color: '#ef4444',
    weight: 12,
    opacity: 0.35,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
    className: 'pulsing-blocked-segment-glow'
  };
}

/**
 * Основная плотная насыщенная линия заблокированного участка
 */
export function getBlockedSegmentStyle() {
  return {
    color: '#dc2626',
    weight: 6,
    opacity: 0.98,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'pulsing-blocked-segment'
  };
}

/**
 * Внутренняя контрастная пунктирная нить
 */
export function getBlockedSegmentCoreStyle() {
  return {
    color: '#ffffff',
    weight: 2,
    dashArray: '8, 8',
    opacity: 0.85,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  };
}

/**
 * Создание полилинии временного пути объезда
 * @returns {Object} Опции Leaflet polyline
 */
export function getDetourSegmentStyle() {
  return {
    color: '#f59e0b',
    weight: 5,
    opacity: 0.95,
    dashArray: '6, 6',
    lineCap: 'round',
    lineJoin: 'round',
    className: 'animated-detour-path'
  };
}

/**
 * Формирование HTML содержимого для попапа перекрытия
 * @param {Object} incident 
 * @param {Function} escapeHtml 
 * @returns {string}
 */
export function buildIncidentPopupHtml(incident, escapeHtml = (s) => s || '') {
  const title = incident.title || incident.passenger_alert?.title || 'Оперативное перекрытие путей';
  const msg = incident.announcement_text || incident.raw_text || incident.passenger_alert?.message || '';
  const routes = (incident.affected_routes || incident.routes || []);
  const routesStr = Array.isArray(routes) ? routes.join(', ') : String(routes || '');
  const dirMeta = getClosureDirectionMeta(incident.direction || incident.blocked_segment?.direction);

  // Закрытые остановки
  let closedStopsHtml = '';
  const closedStops = incident.blocked_segment?.closed_stops || incident.disabled_stop_ids || [];
  if (Array.isArray(closedStops) && closedStops.length > 0) {
    const stopsList = closedStops.map(st => {
      const name = (typeof st === 'object' && st !== null) ? (st.name || st.id) : String(st);
      return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-950/70 border border-rose-800/60 text-[10px] text-rose-300">❌ ${escapeHtml(name)}</span>`;
    }).join(' ');
    closedStopsHtml = `
      <div class="pt-1.5 border-t border-slate-800">
        <div class="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1">Закрытые остановки:</div>
        <div class="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">${stopsList}</div>
      </div>
    `;
  }

  // Схема объезда если есть
  const detourText = incident.detour_text || (incident.detour_path ? 'Действует схема объезда по прилегающим рельсовым путям' : '');
  const detourHtml = detourText ? `
    <div class="p-1.5 rounded-lg bg-amber-950/40 border border-amber-600/40 text-[11px] text-amber-300">
      <span class="font-bold">⚡ Объезд:</span> ${escapeHtml(detourText)}
    </div>
  ` : '';

  return `
    <div class="space-y-2 p-1 min-w-[240px] max-w-[310px]">
      <div class="flex items-center justify-between gap-1.5 border-b border-slate-800 pb-1.5">
        <div class="flex items-center gap-1.5 text-xs font-black text-rose-400">
          <span>⛔</span>
          <span>ПЕРЕКРЫТИЕ ПУТЕЙ</span>
        </div>
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${dirMeta.bgClass} ${dirMeta.borderClass} border ${dirMeta.textClass} text-[10px] font-bold shadow-sm">
          ${dirMeta.icon} ${escapeHtml(dirMeta.shortLabel)}
        </span>
      </div>

      <div class="text-xs text-white font-bold leading-snug">${escapeHtml(title)}</div>

      <div class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center gap-2">
        <span class="text-base shrink-0">${dirMeta.icon}</span>
        <div class="text-[11px] leading-tight">
          <span class="text-slate-400 font-medium">Направление:</span>
          <span class="${dirMeta.textClass} font-bold block">${escapeHtml(dirMeta.label)}</span>
        </div>
      </div>

      ${msg ? `<div class="text-[11px] text-slate-200 leading-snug bg-slate-950/60 p-2 rounded-lg border border-slate-800">${escapeHtml(msg)}</div>` : ''}

      ${detourHtml}

      <div class="flex items-center justify-between text-[11px] pt-1">
        <span class="text-slate-400 font-medium">Маршруты:</span>
        <span class="text-amber-300 font-mono font-bold">${escapeHtml(routesStr || 'Все на участке')}</span>
      </div>

      ${closedStopsHtml}
    </div>
  `;
}

// Экспорт в глобальный scope для совместимости со старыми скриптами
if (typeof window !== 'undefined') {
  window.UETClosures = {
    getClosureDirectionMeta,
    getBlockedSegmentGlowStyle,
    getBlockedSegmentStyle,
    getBlockedSegmentCoreStyle,
    getDetourSegmentStyle,
    buildIncidentPopupHtml
  };
}
