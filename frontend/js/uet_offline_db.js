/**
 * UET Offline Database (uet_offline_db)
 * High-performance Offline-First IndexedDB storage for routes, stops, and infrastructure.
 * Database: uet_offline_db, Version: 1
 * Stores: routes_store (key id), stops_store (key id), meta_store (key key)
 */
(function(window) {
  'use strict';

  const DB_NAME = 'uet_offline_db';
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('routes_store')) {
          const routesStore = db.createObjectStore('routes_store', { keyPath: 'id' });
          try {
            routesStore.createIndex('transport_type', 'transport_type', { unique: false });
            routesStore.createIndex('route_id', 'route_id', { unique: false });
          } catch (e) {}
        }
        if (!db.objectStoreNames.contains('stops_store')) {
          const stopsStore = db.createObjectStore('stops_store', { keyPath: 'id' });
          try {
            stopsStore.createIndex('transport_type', 'transport_type', { unique: false });
          } catch (e) {}
        }
        if (!db.objectStoreNames.contains('meta_store')) {
          db.createObjectStore('meta_store', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        console.error('[UETOfflineDB] open error:', event.target.error);
        reject(event.target.error);
      };
    });
    return dbPromise;
  }

  const UETOfflineDB = {
    async count(storeName) {
      try {
        const db = await openDB();
        return new Promise(res => {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).count();
            req.onsuccess = () => res(req.result || 0);
            req.onerror = () => res(0);
          } catch (e) {
            res(0);
          }
        });
      } catch (e) {
        return 0;
      }
    },

    async setMeta(key, val) {
      try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('meta_store', 'readwrite');
          const store = tx.objectStore('meta_store');
          store.put({ key: key, value: val, updated_at: Date.now() });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn('[UETOfflineDB] setMeta failed:', e);
        return false;
      }
    },

    async getMeta(key) {
      try {
        const db = await openDB();
        return new Promise((resolve) => {
          const tx = db.transaction('meta_store', 'readonly');
          const store = tx.objectStore('meta_store');
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    },

    async saveTracks(type, tracksGeo) {
      if (!tracksGeo) return false;
      await this.setMeta(`tracks_${type}`, tracksGeo);
      await this.setMeta('timestamp_saved', Date.now());
      return true;
    },

    async getTracks(type) {
      return await this.getMeta(`tracks_${type}`);
    },

    async saveStops(type, stopsGeo) {
      if (!stopsGeo) return false;
      await this.setMeta(`stops_geo_${type}`, stopsGeo);

      try {
        const db = await openDB();
        const features = stopsGeo.features || (Array.isArray(stopsGeo) ? stopsGeo : []);
        await new Promise((resolve, reject) => {
          const tx = db.transaction('stops_store', 'readwrite');
          const store = tx.objectStore('stops_store');
          for (const feat of features) {
            const sid = String(feat.id || feat.properties?.['@id'] || feat.properties?.id || '');
            if (sid) {
              const fullId = `${type}_${sid}`;
              store.put({
                id: fullId,
                stop_id: sid,
                transport_type: type,
                name: feat.properties?.name || '',
                feature: feat
              });
            }
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });

        const totalStops = await this.count('stops_store');
        await this.setMeta('stops_count', totalStops);
        await this.setMeta('timestamp_saved', Date.now());
        await this.setMeta('last_sync_time', new Date().toLocaleString('ru-RU'));
        return true;
      } catch (e) {
        console.warn('[UETOfflineDB] saveStops failed:', e);
        return false;
      }
    },

    async getStops(type) {
      const geo = await this.getMeta(`stops_geo_${type}`);
      if (geo && geo.features && geo.features.length > 0) {
        return geo;
      }

      // Резервная сборка из stops_store
      try {
        const db = await openDB();
        return new Promise(resolve => {
          const tx = db.transaction('stops_store', 'readonly');
          const store = tx.objectStore('stops_store');
          const req = store.getAll();
          req.onsuccess = () => {
            const list = req.result || [];
            const filtered = list.filter(item => !type || item.transport_type === type);
            if (filtered.length === 0) return resolve(null);
            resolve({
              type: 'FeatureCollection',
              features: filtered.map(item => item.feature).filter(Boolean)
            });
          };
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    },

    async saveRoutes(type, routesArray) {
      if (!Array.isArray(routesArray)) return false;
      await this.setMeta(`routes_list_${type}`, routesArray);

      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('routes_store', 'readwrite');
          const store = tx.objectStore('routes_store');
          for (const r of routesArray) {
            const tType = r.transport_type || type;
            const rid = String(r.route_id || r.id || '');
            const uid = `${tType === 'tram' ? 'tram' : 'trolley'}_${rid}`;
            store.put({
              id: uid,
              uniqueId: uid,
              route_id: rid,
              transport_type: tType,
              name: r.name || r.route_name || '',
              data: r
            });
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });

        const totalRoutes = await this.count('routes_store');
        await this.setMeta('routes_count', totalRoutes);
        await this.setMeta('timestamp_saved', Date.now());
        await this.setMeta('last_sync_time', new Date().toLocaleString('ru-RU'));
        return true;
      } catch (e) {
        console.warn('[UETOfflineDB] saveRoutes failed:', e);
        return false;
      }
    },

    async getRoutes(type) {
      const list = await this.getMeta(`routes_list_${type}`);
      if (Array.isArray(list) && list.length > 0) {
        return list;
      }

      // Резервное чтение из routes_store
      try {
        const db = await openDB();
        return new Promise(resolve => {
          const tx = db.transaction('routes_store', 'readonly');
          const store = tx.objectStore('routes_store');
          const req = store.getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            const filtered = all.filter(item => !type || item.transport_type === type);
            if (filtered.length === 0) return resolve(null);
            resolve(filtered.map(item => item.data || item));
          };
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    },

    async saveRouteDetails(routeId, routeData) {
      if (!routeId || !routeData) return false;
      const cleanId = String(routeId).trim();
      await this.setMeta(`route_details_${cleanId}`, routeData);
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('routes_store', 'readwrite');
          const store = tx.objectStore('routes_store');
          const tType = routeData.transport_type || (cleanId.startsWith('trolley') ? 'trolleybus' : 'tram');
          const rid = String(routeData.route_id || cleanId);
          store.put({
            id: cleanId,
            uniqueId: cleanId,
            route_id: rid,
            transport_type: tType,
            name: routeData.title || routeData.name || '',
            data: routeData,
            detailed: true
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
        return true;
      } catch (e) {
        console.warn('[UETOfflineDB] saveRouteDetails failed:', e);
        return false;
      }
    },

    async getRouteDetails(routeId) {
      if (!routeId) return null;
      const cleanId = String(routeId).trim();
      const cachedMeta = await this.getMeta(`route_details_${cleanId}`);
      if (cachedMeta) return cachedMeta;

      try {
        const db = await openDB();
        return new Promise(resolve => {
          const tx = db.transaction('routes_store', 'readonly');
          const store = tx.objectStore('routes_store');
          const req = store.get(cleanId);
          req.onsuccess = () => {
            const item = req.result;
            if (item && item.data) {
              resolve(item.data);
            } else {
              resolve(null);
            }
          };
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    },

    async getStats() {
      try {
        const routesCount = await this.count('routes_store');
        const stopsCount = await this.count('stops_store');
        const version = await this.getMeta('data_version');
        const lastSync = await this.getMeta('last_sync_time');
        const timeSaved = await this.getMeta('timestamp_saved');

        let displayTime = lastSync;
        if (!displayTime && timeSaved) {
          displayTime = new Date(timeSaved).toLocaleString('ru-RU');
        }

        return {
          routes_count: routesCount,
          stops_count: stopsCount,
          version: version || '—',
          last_sync: displayTime || null
        };
      } catch (e) {
        return { routes_count: 0, stops_count: 0, version: '—', last_sync: null };
      }
    },

    async clearAll() {
      try {
        const db = await openDB();
        const tx = db.transaction(['routes_store', 'stops_store', 'meta_store'], 'readwrite');
        tx.objectStore('routes_store').clear();
        tx.objectStore('stops_store').clear();
        tx.objectStore('meta_store').clear();
        return new Promise(resolve => {
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch (e) {
        return false;
      }
    }
  };

  window.UETOfflineDB = UETOfflineDB;
})(window);
