/* 一起 To Do 网页版 Service Worker：基础离线缓存
 * - 安装时预缓存全部静态资源（断网后可打开 App、可读本地 IndexedDB 数据）
 * - 页面导航：网络优先，失败回退缓存 index.html（离线壳）
 * - 静态资源：缓存优先，命中后台不刷新；未命中走网络并写缓存
 */
const CACHE = 'yiqi-todo-v6';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/paper.js',
  './js/db.js', './js/config.js', './js/supabase-db.js',
  './js/supabase-js.js', './js/sbv-auth-js.js', './js/sbv-functions-js.js',
  './js/sbv-postgrest-js.js', './js/sbv-realtime-js.js', './js/sbv-storage-js.js',
  './js/sbv-extra-1.js', './js/sbv-extra-2.js', './js/sbv-extra-3.js',
  './js/util.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }
  /* v2.2.2：静态资源网络优先 + 成功回写缓存（保证更新必达），断网才回落缓存 */
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req))
  );
});
