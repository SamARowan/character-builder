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
// Format: the plaintext is cut into RECORD-byte records, each sealed with AES-GCM (16-byte tag),
// IV = 8-byte per-file random prefix || u32 BE record number. Records are grouped PER_PART to a
// part file (under GitHub's 100 MB file limit). web/secure.json describes it all, plus a check
// value the page uses to tell a wrong password at once.

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

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, base,
                                 { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
    secure.files.pack = { ...(await encryptFile(key, src, join(WEB, "pack"), "fuse-content", ".bin")), created };
  }
  writeFileSync(SECURE, JSON.stringify(secure, null, 1) + "\n");
  console.log(`wrote ${SECURE}${same ? "" : " (new key)"}`);
}

await main();
