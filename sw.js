// Same-origin GET assets only. Never turn an API failure into HTTP 200.
const CACHE_NAME = 'checklist-v6';
const FILES_TO_CACHE = [
  './', './index.html', './employee.html', './admin.html',
  './css/style.css', './css/login.css', './css/employee.css',
  './js/config.js', './js/api.js', './js/auth.js', './js/theme.js',
  './js/employee.js', './js/admin.js', './js/pwa-install.js', './js/legacy-export.js',
  './manifest.json', './icons/pwa_logo.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/bg_dark.png', './icons/bg_light.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('checklist-') && key !== CACHE_NAME).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (event.request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
    return Response.error();
  }));
});
