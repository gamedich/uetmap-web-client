// ==========================================
// 1. map_init.js: Инициализация Leaflet и групп слоев
// ==========================================
(function() {
  try {
    // Глобальное состояние карты и базовых сущностей
    window.map = null;
    window.tracksGroup = null;     // Слой геометрии путей / маршрутов
    window.stopsGroup = null;      // Слой маркеров остановок
    window.vehiclesGroup = null;   // Слой маркеров вагонов
    window.closuresGroup = null;   // Слой перекрытий и инцидентов
    window.markersCluster = null;  // Кластеризация остановок
    window.markerInstances = {};   // id -> L.marker
    window.routesLayer = null;     // Для обратной совместимости
    window.vehiclesLayer = null;   // Для обратной совместимости
    window.incidentsLayer = null;  // Для обратной совместимости

    window.points = [];
    window.routes = [];
    window.events = [];
    window.alerts = [];
    window.closuresList = [];
    window.trackSegmentsList = [];
    window.incidents = [];

    window.selectedRouteId = 'all';
    window.activeFilter = 'all';
    window.isDarkTheme = true;
    window.isVehiclesLiveEnabled = true;

    window.TYPE_META = {
      tram: { label: 'Остановка трамвая', icon: '🚊', defaultColor: '#f59e0b' },
      trolley: { label: 'Остановка троллейбуса', icon: '🚎', defaultColor: '#2dd4bf' },
      bus: { label: 'Автобус', icon: '🚌', defaultColor: '#3b82f6' },
      closure: { label: 'Ремонтные работы / Перекрытие', icon: '🚧', defaultColor: '#ef4444' }
    };

    window.escapeHtml = function(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    // Инициализация Telegram WebApp & Haptic Feedback
    try {
      if (window.Telegram && window.Telegram.WebApp) {
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();
        if (tg.disableVerticalSwipes) {
          tg.disableVerticalSwipes();
        }
      }
    } catch (e) {
      console.warn('Telegram WebApp init notice:', e);
    }

    window.haptic = function(type = 'light') {
      try {
        if (window.Telegram?.WebApp?.HapticFeedback) {
          window.Telegram.WebApp.HapticFeedback.impactOccurred(type);
        }
      } catch (e) {}
    };

    window.initMap = function() {
      try {
        const mapDiv = document.getElementById('map');
        if (!mapDiv) return;

        // 1. preferCanvas: true для аппаратного ускорения отрисовки
        window.map = L.map('map', {
          zoomControl: false,
          attributionControl: false,
          preferCanvas: true
        }).setView([54.3188, 48.3977], 13);

        L.control.zoom({ position: 'bottomright' }).addTo(window.map);

        // Подключение кэшированных тайлов с сервера UETMap (ШАГ 8.4)
        L.tileLayer('/map/tiles/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap & MUP UET'
        }).addTo(window.map);

        // Инициализация изолированных групп слоев (базовые пути строго под остальными)
        window.baseTracksGroup = L.featureGroup().addTo(window.map);
        window.tracksGroup = L.featureGroup().addTo(window.map);
        window.stopsGroup = L.featureGroup().addTo(window.map);
        window.vehiclesGroup = L.featureGroup().addTo(window.map);
        window.closuresGroup = L.featureGroup().addTo(window.map);

        // Алиасы для совместимости с кодом
        window.routesLayer = window.tracksGroup;
        window.vehiclesLayer = window.vehiclesGroup;
        window.incidentsLayer = window.closuresGroup;

        // Leaflet.markercluster: группировка близких остановок
        window.markersCluster = L.markerClusterGroup({
          maxClusterRadius: 45,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          disableClusteringAtZoom: 16
        });
        window.stopsGroup.addLayer(window.markersCluster);

        // Скрытие маркеров на мелком зуме (пока виден весь город целиком)
        window.map.on('zoomend', () => {
          try {
            if (window.map.getZoom() < 13) {
              if (window.stopsGroup.hasLayer(window.markersCluster)) {
                window.stopsGroup.removeLayer(window.markersCluster);
              }
            } else {
              if (!window.stopsGroup.hasLayer(window.markersCluster)) {
                window.stopsGroup.addLayer(window.markersCluster);
              }
            }
          } catch (e) {
            console.error('zoomend error:', e);
          }
        });

        // Гарантируем пересчет размеров карты
        setTimeout(() => { if (window.map) window.map.invalidateSize(); }, 150);
        setTimeout(() => { if (window.map) window.map.invalidateSize(); }, 400);
        window.addEventListener('resize', () => { if (window.map) window.map.invalidateSize(); });

        console.log('[map_init.js] Leaflet map & layers initialized successfully');
      } catch (err) {
        console.error('[map_init.js] Failed to initialize map:', err);
      }
    };
  } catch (globalErr) {
    console.error('Global error in map_init.js:', globalErr);
  }
})();
