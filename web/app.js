// The page: a three.js viewer and panels over the worker (worker.js), which runs the builder.
import * as THREE from "three";
import { OrbitControls } from "./vendor/js/OrbitControls.js";
import { zipSync, unzipSync, strToU8, strFromU8 } from "./vendor/js/fflate.mjs";

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// --- the worker --------------------------------------------------------------------------------

const worker = new Worker("./worker.js", { type: "module" });
const pending = new Map();
let nextId = 0;
const progressListeners = new Set();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "progress") { for (const f of progressListeners) f(m); return; }
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
};
function ask(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer);
  });
}
const call = (name, args) => ask({ cmd: "call", name, args });
const readFiles = (paths) => ask({ cmd: "read", paths });

// --- small helpers -------------------------------------------------------------------------------

let toastTimer;
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
}
function fail(e) {
  console.error(e);
  toast(String(e.message ?? e).replace(/^\w+Error: /, ""), true);
}

let busyCount = 0;
async function busy(text, fn) {
  busyCount++;
  $("#busy-text").textContent = text;
  $("#busy").hidden = false;
  try { return await fn(); } finally { if (--busyCount === 0) $("#busy").hidden = true; }
}

// File thumbnails from the worker's filesystem, as object URLs, fetched in batches.
const urlCache = new Map();
let batch = null;
function fileUrl(path, type = "image/png") {
  if (!path) return Promise.resolve("");
  if (urlCache.has(path)) return urlCache.get(path);
  if (!batch) {
    batch = new Map();
    queueMicrotask(async () => {
      const b = batch;
      batch = null;
      const paths = [...b.keys()];
      try {
        const bufs = await readFiles(paths);
        paths.forEach((p, i) => b.get(p).resolve(bufs[i] ? URL.createObjectURL(new Blob([bufs[i]], { type })) : ""));
      } catch (e) {
        paths.forEach((p) => b.get(p).resolve(""));
      }
    });
  }
  let resolve;
  const pr = new Promise((r) => { resolve = r; });
  batch.set(path, { resolve });
  urlCache.set(path, pr);
  return pr;
}
// Thumbnails load as they scroll into view: with the pack streamed, each one is a download.
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    const img = e.target;
    fileUrl(img.dataset.path).then((u) => { if (u) img.src = u; });
  }
}, { rootMargin: "300px" });
function thumb(path, alt = "") {
  const img = el("img", { alt, decoding: "async" });
  if (path) {
    if (urlCache.has(path)) fileUrl(path).then((u) => { if (u) img.src = u; });
    else { img.dataset.path = path; thumbObserver.observe(img); }
  }
  return img;
}

function download(name, data, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const file = new File([blob], name, { type });
  // Phones: the share sheet saves to Files / sends anywhere. Elsewhere: a normal download.
  if (navigator.canShare?.({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
    return navigator.share({ files: [file], title: name }).catch((e) => {
      if (e.name !== "AbortError") saveAs(blob, name);
    });
  }
  saveAs(blob, name);
}
function saveAs(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 30000);
}

// --- saved characters (IndexedDB) ------------------------------------------------------------------

const db = await new Promise((resolve, reject) => {
  const r = indexedDB.open("fuse-builder", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("characters", { keyPath: "id" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
function store(mode = "readonly") { return db.transaction("characters", mode).objectStore("characters"); }
const idb = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const saved = {
  all: () => idb(store().getAll()).then((a) => a.sort((x, y) => y.updated - x.updated)),
  get: (id) => idb(store().get(id)),
  put: (rec) => idb(store("readwrite").put(rec)),
  del: (id) => idb(store("readwrite").delete(id)),
};
const prefs = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`fb.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`fb.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

// --- the viewer -------------------------------------------------------------------------------------

const canvas = $("#view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
camera.position.set(0, 120, 420);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(0, 95, 0);
controls.minDistance = 20;
controls.maxDistance = 1200;
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3328, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(120, 260, 220);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbcd2ff, 1.1);
rim.position.set(-200, 160, -240);
scene.add(rim);
const floor = new THREE.Mesh(new THREE.CircleGeometry(70, 48),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
let character = new THREE.Group();
scene.add(character);

let turning = null;
function frame(animate = false) {
  const box = new THREE.Box3().setFromObject(character);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const fit = Math.max(size.y / 2 / Math.tan((camera.fov * Math.PI) / 360),
                       size.x / 2 / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect) * 1.18;
  const dir = animate ? camera.position.clone().sub(controls.target).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
  if (dir.lengthSq() < 0.5) dir.set(0, 0, 1);
  controls.target.copy(mid);
  camera.position.copy(mid).addScaledVector(dir, fit).add(new THREE.Vector3(0, size.y * 0.06, 0));
  floor.position.set(mid.x, box.min.y + 0.1, mid.z);
  controls.update();
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

let snapshotWanted = false, snapshotResolve = null;
renderer.setAnimationLoop(() => {
  if (turning) {
    const t = Math.min(1, (performance.now() - turning.start) / 700);
    const a = turning.from + (turning.to - turning.from) * (1 - (1 - t) ** 3);
    const off = camera.position.clone().sub(controls.target);
    const r = Math.hypot(off.x, off.z);
    camera.position.set(controls.target.x + Math.sin(a) * r, camera.position.y, controls.target.z + Math.cos(a) * r);
    if (t >= 1) turning = null;
  }
  controls.update();
  renderer.render(scene, camera);
  if (snapshotWanted) {
    snapshotWanted = false;
    snapshotResolve(snapshotOf(canvas));
  }
});
function snapshotOf(src) {
  const s = 160, c = el("canvas", { width: s, height: s });
  const g = c.getContext("2d");
  g.fillStyle = "#22262e";
  g.fillRect(0, 0, s, s);
  const k = Math.max(s / src.width, s / src.height);
  g.drawImage(src, (s - src.width * k) / 2, (s - src.height * k) / 2, src.width * k, src.height * k);
  return c.toDataURL("image/jpeg", 0.72);
}
const snapshot = () => new Promise((r) => { snapshotResolve = r; snapshotWanted = true; });

$("#frame").onclick = () => frame(true);
$("#turn").onclick = () => {
  const off = camera.position.clone().sub(controls.target);
  const a = Math.atan2(off.x, off.z);
  turning = { start: performance.now(), from: a, to: a + Math.PI };
};

// Textures by the paint cache's key: a slider change reuses every one.
const textures = new Map();
async function textureFor(path, k, colour = true) {
  if (!path) return null;
  k ||= path;
  if (!textures.has(k)) {
    textures.set(k, (async () => {
      const [buf] = await readFiles([path]);
      if (!buf) return null;
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
      await img.decode();
      const tex = new THREE.Texture(img);
      tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      return tex;
    })());
  }
  return textures.get(k);
}

let framed = false;
async function showPreview(pv) {
  const [bin] = await readFiles([pv.bin]);
  const group = new THREE.Group();
  const used = new Set();
  await Promise.all(pv.sections.map(async (s) => {
    const verts = new Float32Array(bin, s.offset, s.vertices * 8);
    const idx = new Uint32Array(bin, s.offset + s.vertices * 32, s.indices);
    const g = new THREE.BufferGeometry();
    const ib = new THREE.InterleavedBuffer(verts, 8);
    g.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute("normal", new THREE.InterleavedBufferAttribute(ib, 3, 3));
    g.setAttribute("uv", new THREE.InterleavedBufferAttribute(ib, 2, 6));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const map = await textureFor(s.texture, s.key);
    const normalMap = s.hair ? null : await textureFor(s.normal, s.key && `${s.key}_n`, false);
    if (s.key) { used.add(s.key); used.add(`${s.key}_n`); }
    const cut = s.hair || pv.opacity?.[s.material];
    const mat = new THREE.MeshStandardMaterial({
      map, color: map ? 0xffffff : 0xb8b8b8, roughness: 0.78, metalness: 0,
      side: cut ? THREE.DoubleSide : THREE.FrontSide, alphaTest: cut ? 0.4 : 0, transparent: false,
      ...(normalMap && { normalMap }),
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = s.object;
    group.add(mesh);
  }));
  scene.remove(character);
  character.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  character = group;
  scene.add(character);
  // Forget textures no longer shown (keeps GPU memory flat over a long session).
  for (const [k, p] of textures) {
    if (!used.has(k) && textures.size > 24) { textures.delete(k); p.then((t) => t?.dispose()); }
  }
  $("#view-empty").hidden = true;
  if (!framed) { frame(); framed = true; }
  if (pv.warnings?.length) toast(pv.warnings.join("\n"));
}

// --- the character's state ----------------------------------------------------------------------------

const state = { info: null, sliders: [], bodies: [], lib: null, materials: null, current: null,
                colourTarget: "body", clothCat: "", tab: "body" };

// Rebuilds: one at a time; edits made meanwhile fold into the next.
let wantPreview = false, previewing = null;
function refresh() {
  wantPreview = true;
  if (!previewing) previewing = (async () => {
    while (wantPreview) {
      wantPreview = false;
      try {
        const pv = await busy("Building", () => call("preview"));
        await showPreview(pv);
      } catch (e) { fail(e); }
    }
    previewing = null;
    autosave();
  })();
  return previewing;
}

async function edit(name, args) {
  try {
    state.info = await call(name, args);
    renderInfo();
    refresh();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

function renderInfo() {
  const i = state.info;
  if (!i?.open) return;
  $("#undo").disabled = !i.can_undo;
  $("#redo").disabled = !i.can_redo;
  if (document.activeElement !== $("#char-name")) $("#char-name").value = i.name;
  const body = state.bodies.find((b) => b.id === i.body_types[0]);
  $("#body-name").textContent = body?.display_name ?? i.body_types.join(", ");
  const bt = $("#body-thumb");
  bt.removeAttribute("src");
  if (body?.thumbnail) fileUrl(body.thumbnail).then((u) => { bt.src = u; });
  renderWorn();
  if (state.tab === "clothes") renderClothGrid();
  if (state.tab === "colours") renderColours();
}

// Autosave the open character into "Characters" a moment after it settles.
let saveTimer, savePending = null;
function autosave() {
  clearTimeout(saveTimer);
  savePending = saveNow;
  saveTimer = setTimeout(saveNow, 900);
}
// Leaving the page (switching apps, closing the tab, reloading) saves at once.
addEventListener("visibilitychange", () => { if (document.hidden && savePending) saveNow(); });
addEventListener("pagehide", () => { if (savePending) saveNow(); });
async function saveNow() {
  clearTimeout(saveTimer);
  savePending = null;
  {
    if (!state.current || !state.info?.open) return;
    try {
      const json = await call("project_json");
      const rec = { id: state.current, name: state.info.name, body: state.info.body_types[0], json,
                    thumb: await snapshot(), updated: Date.now() };
      await saved.put(rec);
      prefs.set("last", state.current);
      if (state.tab === "saved") renderSaved();
    } catch (e) { console.warn("autosave", e); }
  }
}

async function opened(info, id) {
  state.info = info;
  state.current = id ?? crypto.randomUUID();
  prefs.set("last", state.current);
  framed = false;
  await loadSliders();
  renderInfo();
  await refresh();
}

async function newCharacter(bodyId) {
  const name = state.bodies.find((b) => b.id === bodyId)?.display_name ?? "Character";
  try {
    const info = await busy("Starting", () => call("new", [bodyId, [], name]));
    await opened(info);
    setTab("body");
  } catch (e) { fail(e); }
}

// --- Body: sliders ------------------------------------------------------------------------------------

async function loadSliders() {
  state.sliders = await call("sliders");
  renderSliders();
}

const pendingShapes = {};
let shapeTimer;
function queueShape(id, value) {
  pendingShapes[id] = value;
  clearTimeout(shapeTimer);
  shapeTimer = setTimeout(flushShapes, 120);
}
async function flushShapes() {
  const w = { ...pendingShapes };
  for (const k in pendingShapes) delete pendingShapes[k];
  if (Object.keys(w).length) await edit("set_blendshapes", [w]);
}

function renderSliders() {
  const box = $("#sliders");
  const q = $("#slider-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const open = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.cat));
  box.replaceChildren();
  const byCat = new Map();
  for (const s of state.sliders) {
    const hay = `${s.category} ${s.group} ${s.label}`.toLowerCase();
    if (q.length && !q.every((w) => hay.includes(w))) continue;
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category).push(s);
  }
  for (const [cat, list] of byCat) {
    const changed = list.filter((s) => Math.abs(s.value) > 1e-4).length;
    const det = el("details", { className: "slider-group", open: q.length > 0 || open.has(cat) || byCat.size === 1 });
    det.dataset.cat = cat;
    det.append(el("summary", {}, el("span", { textContent: cat.replace(/_/g, " ") }),
      el("span", { className: "count", textContent: changed ? `${changed} changed · ${list.length}` : `${list.length}` })));
    let group = null;
    for (const s of list) {
      if (s.group !== group) {
        group = s.group;
        if (group) det.append(el("div", { className: "sub-label", textContent: group.replace(/_/g, " ") }));
      }
      det.append(sliderRow(s));
    }
    box.append(det);
  }
  if (!byCat.size) box.append(el("p", { className: "hint", textContent: "No shapes match." }));
}

function sliderRow(s) {
  const [a, b] = s.label.split(" / ");
  const out = el("output", { textContent: s.value.toFixed(2) });
  const range = el("input", { type: "range", min: s.min, max: 1, step: 0.01, value: s.value });
  // A pair runs from its opposite (left, -1) to its shape (right, +1): "Bicep  Small ← → Big".
  let title = a, ends = null;
  if (b) {
    const wa = a.split(" "), wb = b.split(" ");
    let k = 0;
    while (k < wa.length - 1 && k < wb.length - 1 && wa[k] === wb[k]) k++;
    title = k ? wa.slice(0, k).join(" ") : `${b} / ${a}`;
    ends = `${wb.slice(k).join(" ")} ← → ${wa.slice(k).join(" ")}`;
  }
  const row = el("div", { className: `slider${Math.abs(s.value) > 1e-4 ? " changed" : ""}` },
    el("div", { className: "name" }, el("span", { textContent: title }),
      ends ? el("span", { className: "ends", textContent: ends }) : null),
    range, out);
  range.oninput = () => {
    const v = Number(range.value);
    s.value = v;
    out.textContent = v.toFixed(2);
    row.classList.toggle("changed", Math.abs(v) > 1e-4);
    queueShape(s.id, v);
  };
  // Double-tap the label to zero it.
  row.querySelector(".name").ondblclick = () => { range.value = 0; range.oninput(); };
  return row;
}

$("#slider-search").oninput = renderSliders;
$("#sliders-reset").onclick = async () => {
  if (!confirm("Put every shape back to zero?")) return;
  if (await edit("reset_blendshapes", [""])) await loadSliders();
};
$("#body-change").onclick = () => pickBody("New character with which body?");

function pickBody(title) {
  openPicker(title, state.bodies.map((b) => ({ id: b.id, name: b.display_name, thumb: b.thumbnail })),
    (b) => newCharacter(b.id));
}

// --- Clothes ------------------------------------------------------------------------------------------

async function loadLibrary() {
  state.lib = await call("cloths", ["", "", ""]);
}

function renderWorn() {
  const box = $("#worn");
  box.replaceChildren();
  const cl = state.info?.cloths ?? [];
  if (!cl.length) box.append(el("span", { className: "empty", textContent: "Nothing yet. Pick from below." }));
  for (const c of cl) {
    const meta = state.lib?.cloths.find((x) => x.id === c.id);
    const colour = el("button", { title: "Colours", ariaLabel: `Colours of ${c.display_name}`,
      innerHTML: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></svg>' });
    colour.onclick = () => { state.colourTarget = c.id; setTab("colours"); };
    const rm = el("button", { title: "Take off", ariaLabel: `Take off ${c.display_name}`, innerHTML: ICON_X });
    rm.onclick = () => edit("remove_cloth", [c.id]);
    box.append(el("span", { className: "pill" }, thumb(meta?.thumbnail), el("span", { textContent: c.display_name }), colour, rm));
  }
}

function renderClothGrid() {
  if (!state.lib || !state.info?.open) return;
  const body = state.info.body_types[0];
  const q = $("#cloth-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const mine = `${body}_template`.toLowerCase();
  const fits = state.lib.cloths.filter((c) => state.anyBody || (c.fitted_to ?? "").toLowerCase() === mine);
  const cats = [...new Set(fits.map((c) => c.category).filter(Boolean))].sort();
  if (state.clothCat && !cats.includes(state.clothCat)) state.clothCat = "";
  const chips = $("#cloth-cats");
  const any = el("button", { className: "chip", textContent: "Other bodies' too",
    title: "Show clothes made for other bodies (they're refitted to this one)" });
  any.setAttribute("aria-pressed", String(!!state.anyBody));
  any.onclick = () => { state.anyBody = !state.anyBody; renderClothGrid(); };
  chips.replaceChildren(...["", ...cats].map((cat) => {
    const b = el("button", { className: "chip", textContent: cat || "All" });
    b.setAttribute("aria-pressed", String(cat === state.clothCat));
    b.onclick = () => { state.clothCat = cat; renderClothGrid(); };
    return b;
  }), any);
  const worn = new Set(state.info.cloths.map((c) => c.id));
  const grid = $("#cloth-grid");
  const list = fits.filter((c) => (!state.clothCat || c.category === state.clothCat) &&
    (!q.length || q.every((w) => `${c.display_name} ${c.category} ${c.id}`.toLowerCase().includes(w))));
  grid.replaceChildren(...list.map((c) => {
    const t = el("button", { className: `tile${worn.has(c.id) ? " on" : ""}`, title: c.display_name },
      thumb(c.thumbnail, c.display_name), el("span", { textContent: c.display_name }));
    t.onclick = () => edit(worn.has(c.id) ? "remove_cloth" : "add_cloth", [c.id]);
    return t;
  }));
  if (!list.length) grid.append(el("p", { className: "hint", textContent: "Nothing matches." }));
}
$("#cloth-search").oninput = renderClothGrid;

// --- Colours ------------------------------------------------------------------------------------------

function colourHex(v) {
  return "#" + v.slice(0, 3).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("");
}
function hexColour(h) {
  return [1, 3, 5].map((i) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 1e6) / 1e6);
}

let colourTimer, colourPending = {};
function queueColour(target, key, value) {
  colourPending[key] = value;
  clearTimeout(colourTimer);
  colourTimer = setTimeout(async () => {
    const values = colourPending;
    colourPending = {};
    try {
      await call("set_substance_inputs", [target, values]);
      state.info = await call("info");
      renderInfo();
      refresh();
    } catch (e) { fail(e); }
  }, 220);
}

function inputRow(target, prefix, inp) {
  const key = prefix ? `${prefix}/${inp.name}` : inp.name;
  const label = inp.label || inp.name.replace(/_/g, " ");
  if (inp.type === "float3" || inp.type === "float4" || (inp.value.length >= 3 && !inp.type)) {
    const c = el("input", { type: "color", value: colourHex(inp.value) });
    c.oninput = () => {
      const v = hexColour(c.value);
      queueColour(target, key, inp.value.length === 4 ? [...v, inp.value[3]] : v);
    };
    return el("div", { className: "input-row colour" }, el("span", { className: "lab", textContent: label }), c);
  }
  if (inp.value.length !== 1) return null;
  const isInt = inp.type === "int";
  const lo = inp.min ?? 0, hi = inp.max ?? (isInt ? Math.max(1, inp.value[0]) : 1);
  const val = el("span", { className: "val", textContent: isInt ? inp.value[0] : inp.value[0].toFixed(2) });
  const r = el("input", { type: "range", min: lo, max: hi, step: isInt ? 1 : (hi - lo) / 100, value: inp.value[0] });
  r.oninput = () => {
    const v = Number(r.value);
    val.textContent = isInt ? v : v.toFixed(2);
    queueColour(target, key, [v]);
  };
  return el("div", { className: "input-row" }, el("span", { className: "lab", textContent: label }), val, r);
}

// Colour inputs first, then the few that matter most, the rest folded away.
function inputsBlock(target, prefix, inputs) {
  const isColour = (i) => i.type === "float3" || i.type === "float4";
  const main = inputs.filter((i) => isColour(i) || /hue|saturation|lightness|luminosity|brightness|age|variation|wear|dirt|pattern/i.test(i.name));
  const rest = inputs.filter((i) => !main.includes(i));
  main.sort((a, b) => isColour(b) - isColour(a));
  const box = el("div", { className: "mat-body" }, main.map((i) => inputRow(target, prefix, i)));
  if (rest.length) {
    box.append(el("details", { className: "more" }, el("summary", { textContent: `More settings (${rest.length})` }),
      rest.map((i) => inputRow(target, prefix, i))));
  }
  return box;
}

async function renderColours() {
  const i = state.info;
  if (!i?.open) return;
  const targets = [{ id: "body", name: "Body" }, ...i.cloths.map((c) => ({ id: c.id, name: c.display_name }))];
  if (!targets.some((t) => t.id === state.colourTarget)) state.colourTarget = "body";
  $("#colour-targets").replaceChildren(...targets.map((t) => {
    const b = el("button", { className: "chip", textContent: t.name });
    b.setAttribute("aria-pressed", String(t.id === state.colourTarget));
    b.onclick = () => { state.colourTarget = t.id; renderColours(); };
    return b;
  }));
  const target = state.colourTarget;
  let view;
  try { view = await call("substance", [target]); } catch (e) { fail(e); return; }
  if (target !== state.colourTarget) return;
  const box = $("#colours");
  const keepOpen = new Set([...box.querySelectorAll("details.more[open]")].map((d) => d.closest(".mat")?.dataset.k));
  box.replaceChildren();
  const itemWide = () => {
    if (!view.inputs.length) return;
    const m = el("div", { className: "mat" }, el("div", { className: "mat-head" }, el("span"),
      el("div", { className: "strong", textContent: target === "body" ? "Skin and eyes"
        : view.materials.length ? "Wear and dirt (whole item)" : "This item" }), el("span")),
      inputsBlock(target, "", view.inputs));
    m.dataset.k = "main";
    m.querySelector(".mat-head").style.gridTemplateColumns = "0 1fr 0";
    box.append(m);
  };
  if (!view.materials.length) itemWide();
  for (const mat of view.materials) {
    const change = el("button", { className: "btn", textContent: "Change" });
    change.onclick = () => pickMaterial(target, mat.slot);
    const m = el("div", { className: "mat" },
      el("div", { className: "mat-head" }, thumb(mat.thumbnail, mat.filestem),
        el("div", {}, el("div", { className: "label", textContent: `Material ${mat.slot + 1}`, style: "margin:0" }),
          el("div", { className: "strong", textContent: (mat.display_name || mat.filestem).replace(/_/g, " ") })),
        change),
      inputsBlock(target, String(mat.slot), mat.inputs));
    m.dataset.k = String(mat.slot);
    box.append(m);
  }
  if (view.materials.length) itemWide();
  for (const d of box.querySelectorAll("details.more")) if (keepOpen.has(d.closest(".mat").dataset.k)) d.open = true;
  if (!box.children.length) box.append(el("p", { className: "hint", textContent: "Nothing to colour on this one." }));
}

async function pickMaterial(target, slot) {
  if (!state.materials) state.materials = await call("materials");
  openPicker("Material", state.materials.map((m) => ({ id: m.filestem, name: m.filestem.replace(/_/g, " "), thumb: m.thumbnail })),
    async (m) => {
      try {
        await call("set_material", [target, slot, m.id]);
        state.info = await call("info");
        renderInfo();
        refresh();
      } catch (e) { fail(e); }
    });
}

// --- the picker sheet ---------------------------------------------------------------------------------

let pickerChoose = null, pickerItems = [];
function openPicker(title, items, choose) {
  $("#picker-title").textContent = title;
  $("#picker-search").value = "";
  pickerItems = items;
  pickerChoose = choose;
  renderPicker();
  $("#picker").showModal();
}
function renderPicker() {
  const q = $("#picker-search").value.trim().toLowerCase();
  $("#picker-grid").replaceChildren(...pickerItems.filter((it) => !q || it.name.toLowerCase().includes(q)).map((it) => {
    const t = el("button", { className: "tile", title: it.name }, thumb(it.thumb, it.name), el("span", { textContent: it.name }));
    t.onclick = () => { $("#picker").close(); pickerChoose(it); };
    return t;
  }));
}
$("#picker-search").oninput = renderPicker;
$("#picker").addEventListener("click", (e) => { if (e.target === $("#picker")) $("#picker").close(); });

// --- Export and files -----------------------------------------------------------------------------------

const exportPrefs = prefs.get("export", { format: "glb", rig: "ue", cloths: true, scale: 1 });
$("#ex-format").value = exportPrefs.format;
$("#ex-rig").value = exportPrefs.rig;
$("#ex-cloths").checked = exportPrefs.cloths;
$("#ex-scale").value = exportPrefs.scale;
$("#ex-go").onclick = async () => {
  const p = { format: $("#ex-format").value, rig: $("#ex-rig").value, cloths: $("#ex-cloths").checked,
              scale: Number($("#ex-scale").value) || 1 };
  prefs.set("export", p);
  const go = $("#ex-go");
  go.disabled = true;
  $("#ex-result").textContent = "Painting textures and writing the file…";
  try {
    const t = performance.now();
    const r = await busy("Exporting", () => call("export", [p.format, p.rig, p.cloths, p.scale]));
    const [buf] = await readFiles([r.path]);
    $("#ex-result").textContent = `${r.name}: ${(r.size / 1e6).toFixed(1)} MB, ${r.vertices?.toLocaleString() ?? "?"} vertices` +
      `${r.joints ? `, ${r.joints} joints` : ""} (${((performance.now() - t) / 1000).toFixed(0)} s)`;
    await download(r.name, buf, p.format === "glb" ? "model/gltf-binary" : "application/zip");
  } catch (e) {
    $("#ex-result").textContent = "";
    fail(e);
  } finally { go.disabled = false; }
};
const fileName = (ext) => `${(state.info?.name || "Character").replace(/[^\w\- ]+/g, "_").trim() || "Character"}.${ext}`;
$("#save-json").onclick = async () => {
  try { download(fileName("json"), await call("project_json"), "application/json"); } catch (e) { fail(e); }
};
$("#save-file").onclick = () => $("#save-json").onclick();

// Every character on this device in one .zip of project files: unzip it on the PC and open any of
// them in the desktop builder, or open the .zip here to bring them all back.
$("#save-all").onclick = async () => {
  try {
    if (savePending) await saveNow();
    const list = await saved.all();
    if (!list.length) { toast("No characters saved yet."); return; }
    const files = {}, used = new Set();
    for (const r of list) {
      let base = (r.name || "Character").replace(/[^\w\- ]+/g, "_").trim() || "Character", n = base, i = 2;
      while (used.has(n.toLowerCase())) n = `${base} ${i++}`;
      used.add(n.toLowerCase());
      files[`${n}.json`] = strToU8(r.json);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    download(`Characters ${stamp}.zip`, zipSync(files, { level: 6 }), "application/zip");
  } catch (e) { fail(e); }
};

async function openZip(file) {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /\.json$/i.test(f.name) });
  let n = 0;
  for (const [path, data] of Object.entries(entries)) {
    const json = strFromU8(data);
    let name = path.replace(/^.*\//, "").replace(/\.json$/i, "");
    try { name = JSON.parse(json).name || name; } catch { continue; }
    await saved.put({ id: crypto.randomUUID(), name, body: null, json, thumb: "", updated: Date.now() });
    n++;
  }
  toast(n ? `Added ${n} character${n === 1 ? "" : "s"} to Characters.` : "No character files in that zip.");
  setTab("saved");
}

$("#save-fuse").onclick = async () => {
  try {
    const path = await call("fuse_file");
    const [buf] = await readFiles([path]);
    download(fileName("fuse"), buf);
  } catch (e) { fail(e); }
};

async function openFile(file) {
  try {
    const name = file.name.replace(/\.[^.]+$/, "");
    let info;
    if (/\.zip$/i.test(file.name)) { await openZip(file); return; }
    if (/\.fuse$/i.test(file.name)) {
      const path = await ask({ cmd: "write", path: `/tmp/import/${Date.now()}.fuse`, data: await file.arrayBuffer() });
      info = await busy("Opening", () => call("open_fuse", [path, name]));
    } else {
      info = await busy("Opening", async () => call("open_project", [await file.text()]));
    }
    await opened(info);
    setTab("body");
  } catch (e) { fail(e); }
}
$("#open-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };

// --- Characters ---------------------------------------------------------------------------------------

async function renderSaved() {
  const list = await saved.all();
  const box = $("#saved-list");
  box.replaceChildren();
  if (!list.length) box.append(el("p", { className: "hint", textContent: "Characters you make are kept here on this device." }));
  for (const r of list) {
    const meta = el("div", { className: "meta" }, el("div", { className: "strong", textContent: r.name }),
      el("div", { className: "hint", textContent: `${state.bodies.find((b) => b.id === r.body)?.display_name ?? r.body ?? ""} · ${new Date(r.updated).toLocaleString()}` }));
    const open = async () => {
      if (r.id === state.current) { setTab("body"); return; }
      try {
        const info = await busy("Opening", () => call("open_project", [r.json]));
        await opened(info, r.id);
        setTab("body");
      } catch (e) { fail(e); }
    };
    meta.onclick = open;
    const img = el("img", { src: r.thumb || "", alt: "" });
    img.onclick = open;
    const menu = el("div", { className: "row" });
    const dup = el("button", { className: "icon-btn", title: "Copy", ariaLabel: `Copy ${r.name}`,
      innerHTML: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>' });
    dup.onclick = async () => {
      const d = JSON.parse(r.json);
      d.name = `${r.name} copy`;
      await saved.put({ ...r, id: crypto.randomUUID(), name: d.name, json: JSON.stringify(d), updated: Date.now() });
      renderSaved();
    };
    const del = el("button", { className: "icon-btn", title: "Delete", ariaLabel: `Delete ${r.name}`, innerHTML:
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>' });
    del.onclick = async () => {
      if (!confirm(`Delete "${r.name}" from this device?`)) return;
      await saved.del(r.id);
      if (r.id === state.current) state.current = crypto.randomUUID();
      renderSaved();
    };
    menu.append(dup, del);
    box.append(el("div", { className: `saved${r.id === state.current ? " current" : ""}` }, img, meta, menu));
  }
}
$("#new-char").onclick = () => pickBody("New character: pick a body");

async function renderPackInfo() {
  const st = await ask({ cmd: "status" });
  const m = st.pack?.manifest ?? {};
  const p = st.pack;
  $("#pack-replace").textContent = p.streaming ? "Use a pack file instead" : "Replace the pack";
  $("#pack-remove").textContent = p.streaming ? "Clear the downloaded parts" : "Remove it from this device";
  $("#pack-info").replaceChildren(el("p", { className: "hint", innerHTML:
    (p.streaming ? `Streamed from the site as you use it: ${(p.cached / 1e6).toFixed(0)} of ${(p.bytes / 1e6).toFixed(0)} MB ` +
      `kept on this device so far (those work offline). ` : `${(p.bytes / 1e6).toFixed(0)} MB, stored on this device. `) +
    `${p.files.toLocaleString()} files, made ${m.created}. ` +
    `Textures up to ${m.max_texture} px.<br>This site's storage: ${((st.usage ?? 0) / 1e6).toFixed(0)} MB used` +
    `${st.quota ? ` of ${(st.quota / 1e9).toFixed(1)} GB` : ""}.` +
    (st.site?.newer ? `<br><strong>The site has a different pack (made ${st.site.created}). Replace to download it.</strong>` : "") }));
  $("#lock-device").hidden = !st.secured;
}
$("#lock-device").onclick = async () => {
  if (!confirm("Forget the password on this device? The page asks for it again on the next start.")) return;
  await ask({ cmd: "lock" });
  location.reload();
};
$("#pack-replace").onclick = () => {
  if (!confirm("Replace the content pack? The page reloads and asks for the new file; your characters stay.")) return;
  sessionStorage.setItem("fb.replace", "1");
  location.reload();   // the running builder holds the pack open; the setup screen takes the file
};
$("#pack-remove").onclick = async () => {
  if (!confirm("Remove the content pack's files from this device? Your characters stay.")) return;
  sessionStorage.setItem("fb.remove", "1");
  location.reload();
};

// --- tabs, the sheet and the top bar -------------------------------------------------------------------

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll(".tab-body")) p.hidden = p.dataset.pane !== tab;
  if (tab === "clothes") renderClothGrid();
  if (tab === "colours") renderColours();
  if (tab === "saved") { renderSaved(); renderPackInfo().catch(() => {}); }
}
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => setTab(b.dataset.tab);

// Phone: drag the sheet's grip to give the viewer or the panel more room.
{
  const grip = $("#grip");
  let start = null;
  const setSheet = (h) => {
    const v = Math.max(140, Math.min(innerHeight - 160, h));
    document.documentElement.style.setProperty("--sheet", `${v}px`);
    return v;
  };
  const saved = prefs.get("sheet", null);
  if (saved) setSheet(saved * innerHeight);
  grip.onpointerdown = (e) => {
    start = { y: e.clientY, h: $("#panel").getBoundingClientRect().height };
    grip.setPointerCapture(e.pointerId);
  };
  grip.onpointermove = (e) => { if (start) setSheet(start.h + (start.y - e.clientY) + 14); };
  grip.onpointerup = () => {
    if (!start) return;
    start = null;
    prefs.set("sheet", $("#panel").getBoundingClientRect().height / innerHeight);
  };
}

$("#undo").onclick = async () => { if (await edit("undo")) await loadSliders(); };
$("#redo").onclick = async () => { if (await edit("redo")) await loadSliders(); };
$("#char-name").onchange = () => {
  const v = $("#char-name").value.trim();
  if (v && v !== state.info?.name) edit("set_name", [v]);
};
$("#char-name").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };

// --- start-up --------------------------------------------------------------------------------------------

function show(id) {
  for (const s of ["#lock", "#setup", "#boot", "#app"]) $(s).hidden = s !== id;
  if (id === "#app") resize();
}

function unlockScreen() {
  show("#lock");
  $("#lock-pw").focus();
  return new Promise((resolve) => {
    $("#lock-form").onsubmit = async (e) => {
      e.preventDefault();
      const go = $("#lock-go");
      go.disabled = true;
      go.textContent = "Checking…";
      $("#lock-error").hidden = true;
      try {
        await ask({ cmd: "unlock", password: $("#lock-pw").value });
        $("#lock-pw").value = "";
        resolve();
      } catch (err) {
        $("#lock-error").hidden = false;
        $("#lock-error").textContent = err.message;
      } finally {
        go.disabled = false;
        go.textContent = "Unlock";
      }
    };
  });
}

async function setup(error, site) {
  show("#setup");
  $("#pack-site").hidden = !site;
  if (site) $("#pack-site").textContent = `Download the pack (${(site.size / 1e6).toFixed(0)} MB)`;
  $("#pack-file-label").classList.toggle("primary", !site);
  $("#setup-error").hidden = !error;
  $("#setup-error").textContent = error ?? "";
  const est = await navigator.storage?.estimate?.();
  if (est?.quota) $("#setup-storage").textContent = `This browser lets the page store up to ${(est.quota / 1e9).toFixed(1)} GB.`;
  if (!navigator.storage?.getDirectory) {
    $("#setup-error").hidden = false;
    $("#setup-error").textContent = "This browser can't store the pack (no private file storage). Use a current Chrome, Safari or Firefox, over https.";
  }
  return new Promise((resolve) => {
    const load = async (src) => {
      const bar = $("#setup-progress");
      bar.hidden = false;
      $("#setup-error").hidden = true;
      const onProgress = (m) => {
        bar.querySelector("span").textContent = m.text;
        if (m.frac != null) bar.querySelector(".bar").style.width = `${(m.frac * 100).toFixed(1)}%`;
      };
      progressListeners.add(onProgress);
      try {
        await navigator.storage.persist?.();
        await ask(src.site ? { cmd: "import", site: true } : src.file ? { cmd: "import", file: src.file }
          : { cmd: "import", url: src.url });
        resolve();
      } catch (e) {
        $("#setup-error").hidden = false;
        $("#setup-error").textContent = e.message;
      } finally {
        progressListeners.delete(onProgress);
        bar.hidden = true;
      }
    };
    $("#pack-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) load({ file: f }); };
    $("#pack-url-go").onclick = () => { const u = $("#pack-url").value.trim(); if (u) load({ url: u }); };
    $("#pack-site").onclick = () => load({ site: true });
  });
}

async function boot() {
  if (("serviceWorker" in navigator) && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("service worker", e));
  }
  if (sessionStorage.getItem("fb.remove")) {
    sessionStorage.removeItem("fb.remove");
    await ask({ cmd: "delete" });
  }
  let st = await ask({ cmd: "status" });
  while (st.locked) {
    await unlockScreen();
    st = await ask({ cmd: "status" });
  }
  if (sessionStorage.getItem("fb.replace")) {
    sessionStorage.removeItem("fb.replace");
    await setup(null, st.site);
    st = await ask({ cmd: "status" });
  }
  while (!st.pack) {
    await setup(st.error, st.site);
    st = await ask({ cmd: "status" });
  }
  show("#boot");
  const onProgress = (m) => { $("#boot-text").textContent = m.text; };
  progressListeners.add(onProgress);
  try {
    await ask({ cmd: "start" });
    state.bodies = await call("body_types");
    await loadLibrary();
  } catch (e) {
    $("#boot-error").hidden = false;
    $("#boot-error").textContent = e.message;
    progressListeners.delete(onProgress);
    return;
  }
  progressListeners.delete(onProgress);
  progressListeners.add((m) => { if (busyCount) $("#busy-text").textContent = m.text; });
  show("#app");
  const last = prefs.get("last", null);
  const rec = last && await saved.get(last);
  if (rec) {
    try {
      await opened(await call("open_project", [rec.json]), rec.id);
      return;
    } catch (e) { fail(e); }
  }
  $("#view-empty").hidden = false;
  pickBody("Pick a body to start");
}

boot();

// For the tests.
window.fuseBuilder = { state, call, ask, frame, setTab, newCharacter };
