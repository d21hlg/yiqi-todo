/* 一起 To Do 网页版 Service Worker：基础离线缓存
 * - 安装时预缓存全部静态资源（断网后可打开 App、可读本地 IndexedDB 数据）
 * - 页面导航：网络优先，失败回退缓存 index.html（离线壳）
 * - 静态资源：缓存优先，命中后台不刷新；未命中走网络并写缓存
 */
const CACHE = 'yiqi-todo-v4';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/paper.js',
  './js/db.js', './js/config.js', './js/supabase-db.js',
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
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', cp));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const cp = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, cp));
      return res;
    }))
  );
});
