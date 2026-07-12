/* CarParty.io 서비스워커 — PWA 설치 자격 + 오프라인 폴백.
 *  전략: "네트워크 우선" (항상 최신 코드; 잦은 배포에도 stale 안 됨) → 실패 시 캐시 폴백.
 *  WebSocket 은 fetch 이벤트를 안 거치므로 실시간 통신엔 영향 없음. */
const CACHE = "carparty-v1";
const SHELL = [
  "/", "/index.html", "/game.js", "/style.css",
  "/manifest.webmanifest", "/car-icon.svg",
  "/icon-192.png", "/icon-512.png", "/icon-512-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // WS 업그레이드/POST 등은 그대로 통과
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // 외부 리소스는 그대로
  // 네트워크 우선 → 최신 유지, 성공 시 캐시 갱신, 실패(오프라인) 시 캐시 폴백
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
  );
});
