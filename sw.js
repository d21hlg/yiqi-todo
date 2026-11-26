/* 一起 To Do 网页版 Service Worker v9（hotfix：永远拿最新代码，离线仍可开）
 * - install 不做预缓存（避免任一资源 404 导致安装失败、旧 SW 赖着不走）
 * - 同源 GET 全部「网络优先」：在线永远最新，失败才回退缓存（离线壳）
 * - activate 删除所有旧缓存，防止旧 js 残留
 */
const CACHE = 'yiqi-todo-v11';

self.addEventListener('install', () => { self.skipWaiting(); });

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
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
