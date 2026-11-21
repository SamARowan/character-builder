// AES-256 in CTR mode, synchronous, for the pack's streamed reads: Pyodide reads files
// synchronously and WebCrypto is async only. Encryption side: pack/encrypt.mjs (WebCrypto AES-CTR,
// counter block = 8-byte nonce || 64-bit big-endian block number), so byte i of the pack is
// decrypted by keystream block floor(i / 16) and any range decrypts on its own.

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
{
  // The S-box from the multiplicative inverse in GF(2^8) and the affine map.
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i++) {
    const inv = i ? exp[(255 - log[i]) % 255] : 0;
    let s = inv;
    for (let k = 1; k < 5; k++) s ^= ((inv << k) | (inv >>> (8 - k))) & 0xff;
    SBOX[i] = s ^ 0x63;
  }
  const x2 = (a) => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i], s2 = x2(s), s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = t;
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
}

function expandKey(key) {
  if (key.length !== 32) throw new Error("AES-256 key must be 32 bytes");
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) w[i] = (key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) {
      t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    } else if (i % 8 === 4) {
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
    }
    w[i] = (w[i - 8] ^ t) >>> 0;
  }
  return w;
}

export class AesCtr {
  constructor(key, nonce) {
    this.w = expandKey(key);
    const n = new DataView(nonce.buffer, nonce.byteOffset, 8);
    this.n0 = n.getUint32(0);
    this.n1 = n.getUint32(4);
  }

  // XORs `data` in place with the keystream for absolute pack offset `offset`.
  xor(data, offset) {
    const w = this.w, out = new Uint32Array(4);
    const outB = new Uint8Array(out.buffer);
    let block = Math.floor(offset / 16), skip = offset % 16, i = 0;
    while (i < data.length) {
      // Counter block: nonce (8 bytes) || block number (64-bit big-endian).
      const hi = Math.floor(block / 4294967296) >>> 0, lo = block >>> 0;
      let s0 = this.n0 ^ w[0], s1 = this.n1 ^ w[1], s2 = hi ^ w[2], s3 = lo ^ w[3];
      let k = 4;
      for (let r = 1; r < 14; r++) {
        const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
        const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
        const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
        const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
        s0 = t0; s1 = t1; s2 = t2; s3 = t3; k += 4;
      }
      const f0 = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ w[56];
      const f1 = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ w[57];
      const f2 = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ w[58];
      const f3 = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ w[59];
      // Big-endian bytes of the keystream block.
      outB[0] = f0 >>> 24; outB[1] = f0 >>> 16; outB[2] = f0 >>> 8; outB[3] = f0;
      outB[4] = f1 >>> 24; outB[5] = f1 >>> 16; outB[6] = f1 >>> 8; outB[7] = f1;
      outB[8] = f2 >>> 24; outB[9] = f2 >>> 16; outB[10] = f2 >>> 8; outB[11] = f2;
      outB[12] = f3 >>> 24; outB[13] = f3 >>> 16; outB[14] = f3 >>> 8; outB[15] = f3;
      for (let j = skip; j < 16 && i < data.length; j++) data[i++] ^= outB[j];
      skip = 0;
      block++;
    }
    return data;
  }
}
