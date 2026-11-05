// Verifikasi Ed25519 (RFC 8032) murni JavaScript dengan BigInt, sinkron.
// Hanya verifikasi; penandatanganan dilakukan di server (Node crypto).
import { sha512 } from './sha512';

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
const powMod = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n;
  let x = mod(b, m);
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * x) % m;
    x = (x * x) % m;
    k >>= 1n;
  }
  return r;
};
const inv = (a: bigint) => powMod(a, P - 2n, P);
const D = mod(-121665n * inv(121666n), P);
const SQRT_M1 = powMod(2n, (P - 1n) / 4n, P);

type Pt = [bigint, bigint, bigint, bigint]; // (X, Y, Z, T) koordinat extended

const add = (p: Pt, q: Pt): Pt => {
  const A = mod((p[1] - p[0]) * (q[1] - q[0]), P);
  const B = mod((p[1] + p[0]) * (q[1] + q[0]), P);
  const C = mod(p[3] * 2n * D * q[3], P);
  const Dd = mod(p[2] * 2n * q[2], P);
  const E = mod(B - A, P);
  const F = mod(Dd - C, P);
  const G = mod(Dd + C, P);
  const H = mod(B + A, P);
  return [mod(E * F, P), mod(G * H, P), mod(F * G, P), mod(E * H, P)];
};

const mul = (k: bigint, p: Pt): Pt => {
  let r: Pt = [0n, 1n, 1n, 0n];
  let q = p;
  let s = k;
  while (s > 0n) {
    if (s & 1n) r = add(r, q);
    q = add(q, q);
    s >>= 1n;
  }
  return r;
};

const leToBig = (b: Uint8Array) => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};

/** Titik dari encoding 32 byte; null bila tidak valid. */
function decodePoint(enc: Uint8Array): Pt | null {
  const sign = (enc[31]! >> 7) & 1;
  const yBytes = Uint8Array.from(enc);
  yBytes[31] = yBytes[31]! & 0x7f;
  const y = leToBig(yBytes);
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n, P);
  const v = mod(D * y2 + 1n, P);
  // x = u/v; akar dengan p ≡ 5 (mod 8)
  const x3 = (u * powMod(v, 3n, P)) % P;
  let x = (x3 * powMod((u * powMod(v, 7n, P)) % P, (P - 5n) / 8n, P)) % P;
  if (mod(v * x * x, P) !== u) {
    if (mod(v * x * x, P) !== mod(-u, P)) return null;
    x = (x * SQRT_M1) % P;
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y, P)];
}

const BASE: Pt = (() => {
  const y = (4n * inv(5n)) % P;
  const enc = new Uint8Array(32);
  for (let i = 0; i < 32; i++) enc[i] = Number((y >> BigInt(8 * i)) & 0xffn);
  return decodePoint(enc)!;
})();

const sameProjective = (p: Pt, q: Pt) =>
  mod(p[0] * q[2], P) === mod(q[0] * p[2], P) && mod(p[1] * q[2], P) === mod(q[1] * p[2], P);

/** Periksa tanda tangan Ed25519. publicKey 32 byte, signature 64 byte. */
export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const A = decodePoint(publicKey);
  const R = decodePoint(signature.subarray(0, 32));
  if (!A || !R) return false;
  const S = leToBig(signature.subarray(32));
  if (S >= L) return false;
  const hBuf = new Uint8Array(64 + message.length);
  hBuf.set(signature.subarray(0, 32), 0);
  hBuf.set(publicKey, 32);
  hBuf.set(message, 64);
  const h = mod(leToBig(sha512(hBuf)), L);
  // [S]B == R + [h]A
  return sameProjective(mul(S, BASE), add(R, mul(h, A)));
}
