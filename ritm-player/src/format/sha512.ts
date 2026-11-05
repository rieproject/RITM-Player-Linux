// SHA-512 murni JavaScript (BigInt, sinkron). Konstanta diturunkan dari akar bilangan prima
// (aturan FIPS 180-4), bukan ditulis manual; tes memeriksanya terhadap Node crypto.

const M64 = (1n << 64n) - 1n;

/** Akar pangkat-n bulat terbesar x sehingga x^n <= v (biner, untuk BigInt). */
function iroot(v: bigint, n: bigint): bigint {
  let lo = 0n;
  const bitLen = v.toString(2).length;
  let hi = 1n << BigInt(Math.ceil(bitLen / Number(n)) + 1);
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid ** n <= v) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

const PRIMES: number[] = (() => {
  const out: number[] = [];
  for (let n = 2; out.length < 80; n++) if (out.every((p) => n % p !== 0)) out.push(n);
  return out;
})();

// 64 bit pertama pecahan akar pangkat tiga prima → konstanta K.
const K: bigint[] = PRIMES.map((p) => iroot(BigInt(p) << 192n, 3n) & M64);
// 64 bit pertama pecahan akar kuadrat dari 8 prima pertama → nilai awal H.
const H0: bigint[] = PRIMES.slice(0, 8).map((p) => iroot(BigInt(p) << 128n, 2n) & M64);

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;

/** Ringkasan SHA-512 (64 byte) dari data. */
export function sha512(data: Uint8Array): Uint8Array {
  const len = data.length;
  // padding: 0x80, nol, lalu panjang bit 128-bit big-endian; total kelipatan 128 byte
  const total = ((len + 1 + 16 + 127) >> 7) << 7;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 16; i++) buf[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);

  const H = [...H0];
  const W = new Array<bigint>(80);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let b = 0; b < 8; b++) w = (w << 8n) | BigInt(buf[off + i * 8 + b]!);
      W[i] = w;
    }
    for (let i = 16; i < 80; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = rotr(w15, 1n) ^ rotr(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr(w2, 19n) ^ rotr(w2, 61n) ^ (w2 >> 6n);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) & M64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64;
      d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    const add = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = (H[i]! + add[i]!) & M64;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((H[i]! >> BigInt(56 - 8 * b)) & 0xffn);
  }
  return out;
}
