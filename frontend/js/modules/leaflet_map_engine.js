/**
 * Модуль инициализации и базового конфигурирования карты Leaflet для UETMap.
 * - Границы агломерации Ульяновска (maxBounds)
 * - Настройка Pane (городские маски, подложки)
 * - Кэширующий тайловый слой с локальным прокси
 * - Вспомогательные функции масштабирования и центрирования
 */

export const ULYANOVSK_BOUNDS = [
  [54.1500, 48.1500], // Юго-западная граница (пригород/Киндяковка/Баратаевка)
  [54.4800, 48.7000]  // Северо-восточная граница (Поливно/Новый Город/Архангельское)
];

export const ULYANOVSK_CENTER = [54.3188, 48.3977];
export const DEFAULT_ZOOM = 12;

/**
 * Инициализация экземпляра Leaflet карты
 * @param {string} containerId - id DOM-элемента для карты
 * @returns {L.Map}
 */
export function createLeafletMap(containerId = 'map') {
  if (typeof L === 'undefined') {
    throw new Error('Leaflet library is not loaded');
  }

  const ulyanovskBounds = L.latLngBounds(ULYANOVSK_BOUNDS[0], ULYANOVSK_BOUNDS[1]);

  const map = L.map(containerId, {
    attributionControl: false,
    preferCanvas: true,
    zoomControl: false,
    maxBounds: ulyanovskBounds,
    maxBoundsViscosity: 1.0,
    minZoom: 11,
    maxZoom: 18
  }).setView(ULYANOVSK_CENTER, DEFAULT_ZOOM);

  map.setMaxBounds(ulyanovskBounds);

  // Локальный кэширующий слой тайлов с аварийным upstream OSM
  const tileUrl = window.location.pathname.startsWith('/map') ? '/map/tiles/{z}/{x}/{y}.png?masked=20261113' : '/tiles/{z}/{x}/{y}.png?masked=20261113';
  L.tileLayer(tileUrl, {
    maxZoom: 18,
    minZoom: 11
  }).addTo(map);

  // Pane для виньетки/затемнения за пределами города
  map.createPane('cityMaskPane');
  map.getPane('cityMaskPane').style.zIndex = 300;

  // Pane для оформления подложки карты: выше тайлов (200), ниже путей и остановок (400)
  map.createPane('backdropPane');
  map.getPane('backdropPane').style.zIndex = 350;

  // Наложение маски виньетки
  applyCityOutskirtsMask(map);

  // Автоматический пересчет размеров карты
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
  window.addEventListener('resize', () => { if (map) map.invalidateSize(); });

  return map;
}

/**
 * Затемнение области за пределами агломерации города Ульяновска
 * @param {L.Map} map
 */
export function applyCityOutskirtsMask(map) {
  if (!map) return;
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
