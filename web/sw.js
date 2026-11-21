// Keeps the page working offline: everything it needs is cached on install. The content pack is
// downloaded once into the browser's private storage, so its parts (pack/) are never cached here.
const VERSION = "c69c6f1ebf";
const CACHE = `fuse-builder-${VERSION}`;
const FILES = [
  "./", "index.html", "app.js", "style.css", "worker.js", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/js/three.module.min.js", "vendor/js/OrbitControls.js", "vendor/js/fflate.mjs",
  "vendor/pyodide/pyodide.mjs", "vendor/pyodide/pyodide.asm.js", "vendor/pyodide/pyodide.asm.wasm",
  "vendor/pyodide/python_stdlib.zip", "vendor/pyodide/pyodide-lock.json",
  "vendor/pyodide/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
  "vendor/pyodide/pillow-11.3.0-cp313-cp313-pyodide_2025_0_wasm32.whl",
  "vendor/pyodide/protobuf-6.31.1-cp313-cp313-pyodide_2025_0_wasm32.whl",
];
// The builder's Python: encrypted on the site (secure.json + py.zip.enc), plain only on a local copy.
// These are fetched network-first so the two always match the site when online.
const FRESH = ["secure.json", "py.zip.enc", "py.zip"];

const scope = new URL("./", location.href).pathname;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    for (const f of FRESH) {
      try {
        const res = await fetch(f, { cache: "reload" });
        if (res.ok) await c.put(f, res);
      } catch { /* not on this copy */ }
    }
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("fuse-builder-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);
  if (rel.startsWith("pack/")) return;   // straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (FRESH.includes(rel)) {
      try {
        const res = await fetch(e.request, { cache: "no-cache" });
        if (res.ok) cache.put(e.request, res.clone());
        if (res.ok || res.status === 404) return res;
      } catch { /* offline */ }
      return (await cache.match(e.request, { ignoreSearch: true })) ?? Response.error();
    }
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  })());
});
