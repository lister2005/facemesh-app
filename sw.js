// sw.js -- makes the app installable and usable offline after the first load.
// App files are cached on install; models and MediaPipe files are cached the
// first time they are fetched. Bump VERSION when the app files change.
const VERSION = "facemesh-v2";   // bumped: phones that installed v1 pick up the new files
const SHELL = ["./", "index.html", "app.js", "dots.js", "pipeline.js", "recorder.js",
               "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
    }
    return res;
  })));
});
