/**
 * Pengacakan audio di dalam .ritm (skema "xor-v1").
 *
 * Tujuan: orang yang mengekstrak arsip dengan 7-Zip/WinRAR mendapat audio yang tidak bisa diputar.
 * Ini penghalang, bukan enkripsi: kunci ada di kode player/server/archiver.
 *
 * Algoritma (sengaja sederhana agar mudah ditiru di C++ untuk mesin native):
 *   seed  = fnv1a32(UTF-8 path entry) XOR SCRAMBLE_KEY
 *   state = seed, atau 0x9E3779B9 bila seed = 0
 *   tiap 4 byte: state ^= state<<13; state ^= state>>>17; state ^= state<<5; (uint32)
 *                byte ke-k dari blok XOR-kan dengan (state >>> 8k) & 0xFF (little-endian)
 * Operasi simetris: mengacak dan membalik memakai fungsi yang sama.
 */
import type { RitmAudioRef } from '../types/ritm';

export const SCRAMBLE_XOR_V1 = 'xor-v1' as const;

/** Konstanta platform (ASCII "RITM" = 0x5249544D). Harus sama di player, server, archiver, dan native. */
export const SCRAMBLE_KEY = 0x5249544d;

const enc = new TextEncoder();

/** FNV-1a 32-bit atas UTF-8 path. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const b of enc.encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seed untuk path entry tertentu. */
export function scrambleSeed(entryPath: string): number {
  return (fnv1a32(entryPath) ^ SCRAMBLE_KEY) >>> 0;
}

/** XOR dengan keystream xorshift32, mengembalikan salinan baru (simetris). */
export function xorScramble(data: Uint8Array, entryPath: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length);
  let state = scrambleSeed(entryPath) || 0x9e3779b9;
  for (let i = 0; i < data.length; i += 4) {
    let x = state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state = x >>> 0;
    const n = Math.min(4, data.length - i);
    for (let k = 0; k < n; k++) {
      out[i + k] = data[i + k]! ^ ((state >>> (8 * k)) & 0xff);
    }
  }
  return out;
}

/** Audio yang disimpan di ZIP perlu dibalik bila referensinya bertanda scramble. */
export function unscrambleAudio(stored: Uint8Array<ArrayBuffer>, ref: Pick<RitmAudioRef, 'path' | 'scramble'>): Uint8Array<ArrayBuffer> {
  return ref.scramble === SCRAMBLE_XOR_V1 ? xorScramble(stored, ref.path) : stored;
}
