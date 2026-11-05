// RITM Player Web — service worker.
// Menyimpan aplikasi (HTML, JS, CSS, font, ikon) agar bisa dibuka offline setelah kunjungan pertama.
// File .ritm TIDAK disimpan di sini: file dibuka langsung dari perangkat, bukan dari jaringan.
// Ganti CACHE_VERSION setiap kali aplikasi diperbarui agar cache lama dibuang.
const CACHE_VERSION = 'ritm-web-v9';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(['./', './index.html', './theme.js', './favicon.svg', './apple-touch-icon.png', './icon-192.png', './icon-512.png', './manifest.webmanifest']),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first untuk aset dari origin yang sama; jaringan dipakai bila belum ada di cache.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
