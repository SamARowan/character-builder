// The builder's engine: Pyodide running fuse-mcp's own Python, over the content pack in the
// browser's private storage (OPFS). The page talks to it with {id, cmd, ...} messages and gets
// {id, ok, result | error} back; long jobs also post {type: "progress", text}.
//
// The pack is one file, read in place: every file inside it becomes a read-only node under
// /content whose reads go straight to the pack (stored files) or to a small cache of inflated
// ones (deflated files). Nothing is unpacked up front, so a 500 MB pack costs no memory.

import { loadPyodide } from "./vendor/pyodide/pyodide.mjs";
import { unzlibSync } from "./vendor/js/fflate.mjs";

const PACK = "fuse-content.fpk";
const LIB = "/home/pyodide/lib";
let py = null, api = null, access = null, index = null;

const progress = (text, frac) => postMessage({ type: "progress", text, frac });

// --- the password ------------------------------------------------------------------------------
// The site holds the builder's Python and the pack only encrypted (secure.json, py.zip.enc,
// pack/*.bin; see pack/encrypt.mjs). Unlocking derives the AES key from the password and keeps it
// in this browser as a non-extractable key, so the password is asked once per device.

const keyDb = new Promise((resolve, reject) => {
  const r = indexedDB.open("fuse-builder-key", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function kv(mode, fn) {
  const db = await keyDb;
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const kvGet = (k) => kv("readonly", (s) => s.get(k));
const kvSet = (k, v) => kv("readwrite", (s) => s.put(v, k));
const kvDel = (k) => kv("readwrite", (s) => s.delete(k));

let secureInfo;
async function secure() {
  if (secureInfo === undefined) {
    try {
      const res = await fetch(new URL("./secure.json", import.meta.url), { cache: "no-cache" });
      secureInfo = res.ok ? await res.json() : null;
    } catch {
      secureInfo = null;   // offline: the service worker's copy, or none
    }
  }
  return secureInfo;
}
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function unlock(password) {
  const s = await secure();
  if (!s) throw new Error("This copy of the site has no password set.");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(s.kdf.salt), iterations: s.kdf.iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(s.check.iv) }, key, b64(s.check.data));
  } catch {
    throw new Error("That's not the password.");
  }
  await kvSet("key", { key, salt: s.kdf.salt, check: s.check.data });
  return true;
}
async function storedKey() {
  const s = await secure(), k = await kvGet("key");
  if (!k) return null;
  if (s && (k.salt !== s.kdf.salt || k.check !== s.check.data)) { await kvDel("key"); return null; }  // password changed
  return k.key;
}

// Decrypts a file described in secure.json, record by record, fetching its parts from `dir`.
async function decryptFile(desc, dir, onRecord, label) {
  const key = await storedKey();
  if (!key) throw new Error("Locked: enter the password first.");
  const prefix = b64(desc.prefix);
  const records = Math.ceil(desc.size / desc.record);
  let done = 0;
  for (let p = 0; p < desc.parts.length; p++) {
    const url = new URL(`${dir}${desc.parts[p].name}`, import.meta.url);
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        // Read it as it arrives so the bar moves during the download, not only after each part.
        const total = desc.parts[p].bytes;
        data = new Uint8Array(total);
        let got = 0, shown = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (got + value.byteLength > total) throw new Error("longer than expected");
          data.set(value, got);
          got += value.byteLength;
          if (label && got - shown > (1 << 20)) {
            shown = got;
            const before = desc.parts.slice(0, p).reduce((a, x) => a + x.bytes, 0);
            const all = desc.parts.reduce((a, x) => a + x.bytes, 0);
            progress(`${label}: ${((before + got) / 1e6).toFixed(0)} of ${(all / 1e6).toFixed(0)} MB`, (before + got) / all);
          }
        }
        if (got !== total) throw new Error("cut short");
        break;
      } catch (e) {
        if (attempt >= 4) throw new Error(`Couldn't download ${desc.parts[p].name}: ${e.message}`);
        progress(`${label}: retrying part ${p + 1} (${e.message})`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    let at = 0;
    for (let r = p * desc.per_part; r < Math.min(records, (p + 1) * desc.per_part); r++) {
      const n = Math.min(desc.record, desc.size - r * desc.record) + 16;
      const iv = new Uint8Array(12);
      iv.set(prefix);
      new DataView(iv.buffer).setUint32(8, r);
      let plain;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data.subarray(at, at + n)));
      } catch {
        throw new Error(`${desc.parts[p].name} doesn't decrypt: the site may be mid-update. Try again in a minute.`);
      }
      at += n;
      onRecord(plain, r);
      done += plain.byteLength;
    }
  }
}

// --- the pack -------------------------------------------------------------------------------

async function packHandle(create = false) {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getFileHandle(PACK, { create });
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

function closePack() {
  if (access) { access.close(); access = null; }
}

async function openPack() {
  if (access) return index;
  const fh = await packHandle();
  if (!fh) return null;
  access = await fh.createSyncAccessHandle();
  const size = access.getSize();
  const head = new Uint8Array(24);
  if (size < 24 || access.read(head, { at: 0 }) < 24 ||
      new TextDecoder().decode(head.subarray(0, 4)) !== "FPK1") {
    closePack();
    throw new Error("The stored file isn't a content pack (it should start FPK1). Load the pack again.");
  }
  const dv = new DataView(head.buffer);
  const at = Number(dv.getBigUint64(8, true)), n = Number(dv.getBigUint64(16, true));
  if (at + n > size) {
    closePack();
    throw new Error(`The stored pack is cut short (${size} of ${at + n} bytes). Load it again.`);
  }
  const raw = new Uint8Array(n);
  access.read(raw, { at });
  index = JSON.parse(new TextDecoder().decode(raw));
  index.bytes = size;
  return index;
}

async function importPack(source) {
  // source: a File/Blob, or {url}. Written over any pack already stored.
  closePack();
  const fh = await packHandle(true);
  const out = await fh.createSyncAccessHandle();
  try {
    out.truncate(0);
    let at = 0;
    const write = (chunk, total) => {
      out.write(chunk, { at });
      at += chunk.byteLength;
      progress(`Copying the pack: ${(at / 1e6).toFixed(0)}${total ? ` of ${(total / 1e6).toFixed(0)}` : ""} MB`,
               total ? at / total : undefined);
    };
    if (source.site) {
      const desc = (await secure())?.files?.pack;
      if (!desc) throw new Error("The site has no content pack.");
      await decryptFile(desc, "./pack/", (plain, r) => {
        out.write(plain, { at: r * desc.record });
        at = r * desc.record + plain.byteLength;
      }, "Downloading the pack");
      await kvSet("pack-id", desc.prefix);
    } else if (source.url) {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`${source.url}: ${res.status} ${res.statusText}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        write(value, total);
      }
    } else {
      const STEP = 8 << 20;
      for (let pos = 0; pos < source.size; pos += STEP) {
        write(new Uint8Array(await source.slice(pos, pos + STEP).arrayBuffer()), source.size);
      }
    }
    out.flush();
  } finally {
    out.close();
  }
  try {
    return await openPack();
  } catch (e) {
    await deletePack();
    throw e;
  }
}

async function deletePack() {
  closePack();
  index = null;
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(PACK); } catch (e) { if (e.name !== "NotFoundError") throw e; }
}

// Inflated deflate entries, newest last, up to CACHE_BYTES.
const CACHE_BYTES = 96 << 20;
const inflatedCache = new Map();
let cachedBytes = 0;

function inflated(entry) {
  const key = entry[0];
  let data = inflatedCache.get(key);
  if (data) {
    inflatedCache.delete(key);
    inflatedCache.set(key, data);
    return data;
  }
  const raw = new Uint8Array(entry[2]);
  access.read(raw, { at: entry[1] });
  data = unzlibSync(raw);
  inflatedCache.set(key, data);
  cachedBytes += data.byteLength;
  for (const [k, v] of inflatedCache) {
    if (cachedBytes <= CACHE_BYTES || inflatedCache.size <= 1) break;
    inflatedCache.delete(k);
    cachedBytes -= v.byteLength;
  }
  return data;
}

function mountPack(FS, root) {
  const dirs = new Set();
  for (const entry of index.files) {
    const [path, offset, , size, codec] = entry;
    const full = `${root}/${path}`;
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (!dirs.has(dir)) { FS.mkdirTree(dir); dirs.add(dir); }
    const node = FS.create(full, 0o444);
    Object.defineProperty(node, "usedBytes", { get: () => size });
    const ops = Object.assign({}, node.stream_ops);
    ops.read = (stream, buffer, at, length, position) => {
      if (position >= size) return 0;
      const n = Math.min(length, size - position);
      const into = new Uint8Array(buffer.buffer, buffer.byteOffset + at, n);
      if (codec === "store") access.read(into, { at: offset + position });
      else into.set(inflated(entry).subarray(position, position + n));
      return n;
    };
    ops.write = () => { throw new FS.ErrnoError(30); };  // EROFS
    ops.mmap = () => { throw new FS.ErrnoError(19); };   // ENODEV
    node.stream_ops = ops;
  }
}

// --- Python ---------------------------------------------------------------------------------

async function start() {
  if (api) return JSON.parse(api.call("status", "[]")).result;
  if (!await openPack()) throw new Error("No content pack is stored yet.");
  progress("Starting Python");
  const base = new URL("./", import.meta.url).href;
  py = await loadPyodide({ indexURL: `${base}vendor/pyodide/`, stdout: (s) => console.log(s),
                           stderr: (s) => console.warn(s) });
  progress("Loading numpy, Pillow and protobuf");
  await py.loadPackage(["numpy", "pillow", "protobuf"], { messageCallback: () => {} });
  progress("Loading the builder");
  const s = await secure();
  let zip;
  if (s?.files?.py) {
    const desc = s.files.py, buf = new Uint8Array(desc.size);
    await decryptFile(desc, "./", (plain, r) => buf.set(plain, r * desc.record));
    zip = buf.buffer;
  } else {
    zip = await (await fetch(`${base}py.zip`, { cache: "no-cache" })).arrayBuffer();
  }
  py.unpackArchive(zip, "zip", { extractDir: LIB });
  py.runPython(`import sys; sys.path.insert(0, "${LIB}")`);
  api = py.pyimport("fuseweb");
  mountPack(py.FS, "/content");
  progress("Reading the library");
  return pycall("init", ["/content", JSON.stringify(index.manifest)]);
}

function pycall(name, args) {
  if (!api) throw new Error("The builder hasn't started");
  const out = JSON.parse(api.call(name, JSON.stringify(args ?? [])));
  if (!out.ok) {
    console.error(out.trace);
    throw new Error(out.error);
  }
  return out.result;
}

function readFiles(paths) {
  const out = [], transfer = [];
  for (const p of paths) {
    try {
      const data = py.FS.readFile(p);
      out.push(data.buffer);
      transfer.push(data.buffer);
    } catch {
      out.push(null);
    }
  }
  return [out, transfer];
}

// --- messages, one at a time ----------------------------------------------------------------

async function handle(msg) {
  switch (msg.cmd) {
    case "status": {
      const idx = await openPack().catch((e) => ({ error: e.message }));
      const est = await navigator.storage.estimate?.();
      const s = await secure();
      const site = s?.files?.pack;
      return { pack: idx && !idx.error ? { manifest: idx.manifest, bytes: idx.bytes, files: idx.files.length } : null,
               error: idx?.error, started: !!api, usage: est?.usage, quota: est?.quota,
               secured: !!s, locked: !!s && !(await storedKey()),
               site: site ? { size: site.size, created: site.created, newer: (await kvGet("pack-id")) !== site.prefix } : null };
    }
    case "unlock":
      return unlock(msg.password);
    case "lock":
      await kvDel("key");
      return true;
    case "import":
      if (api) throw new Error("Reload the page before replacing the pack");
      await importPack(msg.site ? { site: true } : msg.file ?? { url: msg.url });
      if (!msg.site) await kvDel("pack-id");
      return { ok: true };
    case "delete":
      if (api) throw new Error("Reload the page before removing the pack");
      await deletePack();
      return { ok: true };
    case "start":
      return start();
    case "call":
      if (msg.name === "preview" || msg.name === "export") progress(msg.name === "export" ? "Exporting" : "Building");
      return pycall(msg.name, msg.args);
    case "read":
      return { files: readFiles(msg.paths), transfer: true };
    case "write":
      py.FS.mkdirTree(msg.path.slice(0, msg.path.lastIndexOf("/")));
      py.FS.writeFile(msg.path, new Uint8Array(msg.data));
      return msg.path;
    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}

let queue = Promise.resolve();
onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(async () => {
    const t = performance.now();
    try {
      const result = await handle(msg);
      if (result?.transfer) {
        const [files, transfer] = result.files;
        postMessage({ id: msg.id, ok: true, result: files, ms: performance.now() - t }, transfer);
      } else {
        postMessage({ id: msg.id, ok: true, result, ms: performance.now() - t });
      }
    } catch (err) {
      postMessage({ id: msg.id, ok: false, error: err?.message ?? String(err), ms: performance.now() - t });
    }
  });
};
