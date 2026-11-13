/**
 * Модуль расчета примерного времени прибытия (ETA - Estimated Time of Arrival)
 * на основе евклидова/сферического расстояния по треку и средней скорости подвижного состава.
 */

/**
 * Расчет расстояния между двумя географическими координатами (по формуле Haversine в метрах)
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // радиус Земли в метрах
  const toRad = (angle) => (angle * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Расчет примерного времени прибытия (в минутах)
 * @param {number} distanceMeters - Расстояние до остановки в метрах
 * @param {number} speedKmh - Скорость транспорта (по умолчанию 18 км/ч в городском трафике)
 * @returns {number} Количество минут
 */
export function estimateArrivalMinutes(distanceMeters, speedKmh = 18) {
  if (distanceMeters <= 0) return 0;
  const speedMetersPerMin = (speedKmh * 1000) / 60; // м/мин (~300 м/мин)
  const minutes = Math.round(distanceMeters / speedMetersPerMin);
  return Math.max(1, minutes);
}

/**
 * Форматирование времени ожидания в понятный текст
 * @param {number} minutes 
 * @returns {string} Текст вида "2 мин", "5 мин", "< 1 мин"
 */
export function formatEtaString(minutes) {
  if (minutes <= 1) return '< 1 мин';
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `${hours} ч ${rem} мин`;
  }
  return `${minutes} мин`;
}
