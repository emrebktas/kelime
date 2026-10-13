// Uygulama dosyalarını önbelleğe alır: internet yokken de açılır.
// Önce ağ (her zaman en yeni sürüm), ağ yoksa ya da yavaşsa önbellek.

const CACHE = 'kelime-v27';
const ASSETS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/sync.js', 'js/srs.js', 'js/config.js',
  'vendor/supabase.js', 'vendor/capacitor.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo.png',
  'content/task1-collocations.json',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' → tarayıcının HTTP önbelleğini atla; yeni sürüme eski dosya girmesin
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // cache: 'no-cache' → her seferinde sunucuya "değişti mi?" diye sor (değişmediyse kısa 304 cevabı).
      // GitHub Pages dosyaları 10 dk önbellekte tutturuyor; bu olmadan güncellemeler gecikiyordu.
      const res = await Promise.race([
        // (sayfa açılış istekleri ayarla kopyalanamaz; adresle yeniden istenir)
        fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
      ]);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      return hit || (await cache.match('index.html')) || Response.error();
    }
  })());
});
