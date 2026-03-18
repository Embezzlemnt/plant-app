const CACHE = 'sachas-soil-v3';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// ── INSTALL: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: serve from cache, fall back to network ─────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── PUSH: receive push from server ────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || "Sacha's Soil 🌸", {
      body: data.body || 'Time to check on your plants!',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'plant-reminder',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

// ── NOTIFICATION CLICK: open app ──────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      return clients.openWindow(e.notification.data?.url || '/');
    })
  );
});

// ── BACKGROUND SYNC: check watering on wake ───────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'check-watering') {
    e.waitUntil(checkWateringReminders());
  }
});

// ── PERIODIC SYNC: daily check (where supported) ─────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'daily-watering-check') {
    e.waitUntil(checkWateringReminders());
  }
});

async function checkWateringReminders() {
  // Read plant data from cache/IndexedDB via message to client
  // or check directly from stored data
  const allClients = await clients.matchAll({ includeUncontrolled: true });

  // Try to get data from an open client first
  if (allClients.length > 0) {
    return; // App is open, it handles its own notifications
  }

  // App is closed — read from IndexedDB
  const data = await getStoredPlantData();
  if (!data) return;

  const { plants, logs, settings } = data;
  if (!settings?.daily && !settings?.ahead) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);

  function daysUntil(p) {
    if (!p.lastWatered) return 0;
    const next = new Date(p.lastWatered);
    next.setDate(next.getDate() + p.waterEvery);
    next.setHours(0, 0, 0, 0);
    return Math.round((next - today) / 86400000);
  }

  const needsWater = plants.filter(p => daysUntil(p) <= 0);
  const tomorrow = plants.filter(p => daysUntil(p) === 1);

  if (settings.daily && needsWater.length) {
    await self.registration.showNotification("time to water! 💧", {
      body: needsWater.map(p => p.name).join(', ') + ' need water today',
      icon: '/icon-192.png',
      tag: 'water-today',
      renotify: true,
      actions: [{ action: 'open', title: 'open app' }]
    });
  }

  if (settings.ahead && tomorrow.length) {
    await self.registration.showNotification("watering tomorrow 🌿", {
      body: tomorrow.map(p => p.name).join(', ') + ' will need water tomorrow',
      icon: '/icon-192.png',
      tag: 'water-tomorrow',
      renotify: true
    });
  }
}

// ── READ PLANT DATA FROM LOCALSTORAGE VIA INDEXEDDB BRIDGE ───────────────────
function getStoredPlantData() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('sachas-soil-bridge', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const results = {};
        const keys = ['mg_plants', 'mg_logs', 'mg_settings'];
        let pending = keys.length;
        keys.forEach(k => {
          const r = store.get(k);
          r.onsuccess = () => {
            results[k] = r.result ? JSON.parse(r.result.value) : null;
            if (--pending === 0) resolve({
              plants: results['mg_plants'] || [],
              logs: results['mg_logs'] || [],
              settings: results['mg_settings'] || {}
            });
          };
          r.onerror = () => { if (--pending === 0) resolve(null); };
        });
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// ── RECEIVE DATA SYNC FROM MAIN APP ──────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SYNC_DATA') {
    syncToIDB(e.data.payload);
  }
  if (e.data?.type === 'SCHEDULE_REMINDER') {
    scheduleLocalReminder(e.data.time, e.data.settings);
  }
});

async function syncToIDB(payload) {
  return new Promise(resolve => {
    const req = indexedDB.open('sachas-soil-bridge', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      Object.entries(payload).forEach(([key, value]) => {
        store.put({ key, value: JSON.stringify(value) });
      });
      tx.oncomplete = resolve;
    };
    req.onerror = resolve;
  });
}

function scheduleLocalReminder(timeStr, settings) {
  // Store reminder schedule for periodic sync fallback
  syncToIDB({ reminder_settings: settings, reminder_time: timeStr });
}
