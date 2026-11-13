/**
 * Модуль клиентской телеметрии подвижного состава (UETMap Passenger Telemetry)
 * - Подключение к WebSocket /ws/telemetry с автореконнектом
 * - Фильтрация служебных/деповских вагонов от пассажиров
 * - Расчет курсового угла (bearing) по изменению координат
 * - Фоновый опрос (polling) при обрыве вебсокета
 */

export function calculateBearingAngle(lat1, lon1, lat2, lon2) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x = Math.cos(rLat1) * Math.sin(rLat2) - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
  let brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

/**
 * Фильтрация служебных единиц транспорта для публичной пассажирской карты
 * @param {Array} vehicles 
 * @returns {Array}
 */
export function filterPublicVehicles(vehicles) {
  if (!Array.isArray(vehicles)) return [];
  return vehicles.filter(
    (v) =>
      v &&
      !v.hide_from_public &&
      v.status !== 'service' &&
      v.status !== 'depot' &&
      v.route_id !== 'Служебный' &&
      v.route_id !== 'В депо' &&
      v.route_id !== 'Буксир'
  );
}

/**
 * Подключение к WebSocket телеметрии
 * @param {Object} options
 * @param {Function} options.onVehiclesUpdate - колбэк при получении списка вагонов
 * @param {Function} options.onIncidentUpdate - колбэк при изменении перекрытий/инцидентов
 * @returns {WebSocket|null}
 */
export function connectTelemetryWebSocket({ onVehiclesUpdate, onIncidentUpdate }) {
  try {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/telemetry`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'VEHICLES_TELEMETRY' && Array.isArray(msg.vehicles)) {
          const publicList = filterPublicVehicles(msg.vehicles);
          if (typeof onVehiclesUpdate === 'function') {
            onVehiclesUpdate(publicList);
          }
        }
        if (
          msg.event === 'INCIDENT_UPDATED' ||
          msg.event === 'INCIDENT_RESOLVED' ||
          msg.event === 'ALERT_NEW' ||
          msg.event === 'ALERT_DISMISSED' ||
          msg.event === 'CLOSURE_RESOLVED'
        ) {
          if (typeof onIncidentUpdate === 'function') {
            onIncidentUpdate();
          }
        }
      } catch (e) {
        console.warn('[Telemetry WS] Message parsing error:', e);
      }
    };

    ws.onclose = () => {
      setTimeout(() => connectTelemetryWebSocket({ onVehiclesUpdate, onIncidentUpdate }), 10000);
    };

    return ws;
  } catch (e) {
    console.warn('[Telemetry WS] Connection failed:', e);
    return null;
  }
}
