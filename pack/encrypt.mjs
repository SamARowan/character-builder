// Encrypts what the public site must not show in the clear, under a key made from the site's password.
//
//   node pack/encrypt.mjs py      web/py.zip                      -> web/py.zip.enc
//   node pack/encrypt.mjs pack    dist-content/fuse-content.fpk  -> web/pack/fuse-content.NN.bin
//   node pack/encrypt.mjs all     both
//
// The password is in secret/password.txt (made on first run if missing; git-ignored, never
// published). Its key is PBKDF2-SHA256 (600k rounds, salt in secret/salt.txt) -> AES-256-GCM.
// The salt stays fixed so devices that unlocked once keep working after a rebuild. Changing the
// password re-encrypts everything.
//
// Formats. py.zip: cut into RECORD-byte records, each sealed with AES-GCM (16-byte tag),
// IV = 8-byte per-file random prefix || u32 BE record number. The pack: AES-CTR over the whole
// file, cut into PART-byte part files (under GitHub's 100 MB limit), so the page streams it with
// range requests and decrypts any piece on its own (see web/aes.js). web/secure.json describes it
// all, plus a check value the page uses to tell a wrong password at once.

import { webcrypto as crypto, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = join(ROOT, "secret"), WEB = join(ROOT, "web");
const SECURE = join(WEB, "secure.json");
const RECORD = 4 << 20, PER_PART = 11, ITERATIONS = 600000;
const CHECK = "fuse-web unlocked";

function secret() {
  mkdirSync(SECRET, { recursive: true });
  const pw = join(SECRET, "password.txt"), salt = join(SECRET, "salt.txt");
  if (!existsSync(pw)) {
    // 4 groups of 4 from an alphabet without look-alikes: ~80 bits, easy to type on a phone.
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    const b = randomBytes(16);
    const s = [...b].map((x) => abc[x % abc.length]).join("");
    writeFileSync(pw, `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}\n`);
    console.log(`made a password in ${pw}`);
  }
  if (!existsSync(salt)) writeFileSync(salt, randomBytes(16).toString("base64") + "\n");
  return { password: readFileSync(pw, "utf8").trim(), salt: Buffer.from(readFileSync(salt, "utf8").trim(), "base64") };
}

// The raw 32-byte key; the page derives the same bytes (it needs them for its synchronous AES).
async function deriveRaw(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, base, 256));
}
const deriveKey = async (password, salt) => (KEY_RAW = await deriveRaw(password, salt),
  crypto.subtle.importKey("raw", KEY_RAW, "AES-GCM", false, ["encrypt", "decrypt"]));
let KEY_RAW;

// The pack: AES-CTR (no per-record framing), so the page can fetch any byte range of a part and
// decrypt just that. Counter block = 8-byte nonce || 64-bit big-endian block number (offset / 16).
const PART = 44 << 20;   // a multiple of 16 and of the page's 64 KB cache chunks
async function encryptPackCtr(src, outDir, base, partExt) {
  const key = await crypto.subtle.importKey("raw", KEY_RAW, "AES-CTR", false, ["encrypt"]);
  const size = statSync(src).size, nonce = randomBytes(8), parts = [];
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.startsWith(`${base}.`) && f.endsWith(partExt)) rmSync(join(outDir, f));
  const fd = openSync(src, "r");
  try {
    for (let p = 0; p * PART < size; p++) {
      const n = Math.min(PART, size - p * PART), buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, p * PART);
      const counter = new Uint8Array(16);
      counter.set(nonce);
      new DataView(counter.buffer).setBigUint64(8, BigInt((p * PART) / 16));
      const ct = Buffer.from(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, buf));
      const name = `${base}.${String(p).padStart(2, "0")}${partExt}`;
      writeFileSync(join(outDir, name), ct);
      parts.push({ name, bytes: ct.length });
      process.stdout.write(`\r${base}: part ${p + 1} of ${Math.ceil(size / PART)}`);
    }
  } finally { closeSync(fd); }
  process.stdout.write("\n");
  return { mode: "ctr", size, part: PART, nonce: nonce.toString("base64"), parts };
}

const ivFor = (prefix, n) => { const iv = new Uint8Array(12); iv.set(prefix); new DataView(iv.buffer).setUint32(8, n); return iv; };

async function encryptFile(key, src, outDir, base, partExt) {
  const size = statSync(src).size;
  const prefix = randomBytes(8);
  const records = Math.ceil(size / RECORD);
  const parts = [];
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.startsWith(`${base}.`) && f.endsWith(partExt)) rmSync(join(outDir, f));
  const fd = openSync(src, "r");
  const buf = Buffer.alloc(RECORD);
  try {
    for (let p = 0; p * PER_PART < records; p++) {
      const chunks = [];
      for (let r = p * PER_PART; r < Math.min(records, (p + 1) * PER_PART); r++) {
        const n = readSync(fd, buf, 0, RECORD, r * RECORD);
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(prefix, r) }, key, buf.subarray(0, n));
        chunks.push(Buffer.from(ct));
      }
      const name = records > PER_PART ? `${base}.${String(p).padStart(2, "0")}${partExt}` : `${base}${partExt}`;
      const data = Buffer.concat(chunks);
      writeFileSync(join(outDir, name), data);
      parts.push({ name, bytes: data.length });
      process.stdout.write(`\r${base}: part ${p + 1} of ${Math.ceil(records / PER_PART)}`);
    }
  } finally { closeSync(fd); }
  process.stdout.write("\n");
  return { size, record: RECORD, per_part: PER_PART, prefix: prefix.toString("base64"), parts };
}

async function main() {
  const what = process.argv[2] ?? "all";
  const { password, salt } = secret();
  const key = await deriveKey(password, salt);
  let secure = existsSync(SECURE) ? JSON.parse(readFileSync(SECURE, "utf8")) : {};
  // A new password or salt: start over, everything gets encrypted again.
  let same = false;
  if (secure.check && secure.kdf?.salt === salt.toString("base64")) {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(secure.check.iv, "base64") }, key,
                                             Buffer.from(secure.check.data, "base64"));
      same = new TextDecoder().decode(pt) === CHECK;
    } catch { same = false; }
  }
  if (!same) {
    const iv = randomBytes(12);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(CHECK));
    secure = { format: "fuse-web-secure", version: 1,
               kdf: { name: "PBKDF2-SHA256", salt: salt.toString("base64"), iterations: ITERATIONS },
               check: { iv: iv.toString("base64"), data: Buffer.from(data).toString("base64") }, files: {} };
  }
  // A new key re-encrypts both, so the site never mixes two keys.
  const doPy = what !== "pack" || !same;
  const doPack = what !== "py" || !same;
  if (doPy) {
    secure.files.py = { ...(await encryptFile(key, join(WEB, "py.zip"), WEB, "py.zip", ".enc")) };
  }
  if (doPack) {
    const src = join(ROOT, "dist-content", "fuse-content.fpk");
    const fh = openSync(src, "r");
    const head = Buffer.alloc(24);
    readSync(fh, head, 0, 24, 0);
    const at = Number(head.readBigUInt64LE(8)), n = Number(head.readBigUInt64LE(16));
    const idx = Buffer.alloc(n);
    readSync(fh, idx, 0, n, at);
    closeSync(fh);
    const created = JSON.parse(idx.toString("utf8")).manifest.created;
    secure.files.pack = { ...(await encryptPackCtr(src, join(WEB, "pack"), "fuse-content", ".bin")), created };
  }
  writeFileSync(SECURE, JSON.stringify(secure, null, 1) + "\n");
  console.log(`wrote ${SECURE}${same ? "" : " (new key)"}`);
}

await main();
