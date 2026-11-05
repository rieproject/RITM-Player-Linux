// Pembaca entry audio .ritm yang TERKOMPRESI (deflate) untuk mesin native.
// Mesin native hanya membaca entry yang disimpan tanpa kompresi (stored). Arsip lama bisa memakai deflate
// untuk audio; modul ini membukanya di proses utama (zlib bawaan Node), membalik acakan "xor-v1", lalu
// memverifikasi hash SHA-256 dari integrity.json sebelum hasilnya diberikan ke mesin native.
// Algoritma acakan sama persis dengan ritm-player/src/format/scramble.ts dan native/src/io.hpp.
'use strict';
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const SCRAMBLE_KEY = 0x5249544d;
const SCRAMBLE_XOR_V1 = 'xor-v1';
const INTEGRITY_PATH = 'integrity.json';
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Seed acakan untuk nama entry (FNV-1a atas UTF-8, di-XOR dengan kunci platform). */
function scrambleSeed(entry) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(entry, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) ^ SCRAMBLE_KEY) >>> 0;
}

/** XOR dengan keystream xorshift32 (simetris: dipakai untuk mengacak dan membalik). Mengembalikan salinan baru. */
function xorScramble(data, entry) {
  const out = Buffer.from(data);
  let state = scrambleSeed(entry) || 0x9e3779b9;
  for (let i = 0; i < out.length; i += 4) {
    let x = state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state = x >>> 0;
    const n = Math.min(4, out.length - i);
    for (let k = 0; k < n; k++) out[i + k] ^= (state >>> (8 * k)) & 0xff;
  }
  return out;
}

async function readExact(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error('arsip terpotong');
  return buf;
}

/** Membaca direktori pusat ZIP → Map nama entry → metadata. ZIP64 belum didukung (arsip RITM kecil). */
async function readZipIndex(fh, size) {
  const tailLen = Math.min(size, 0xffff + 22);
  const tail = await readExact(fh, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('arsip ZIP tidak valid');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 belum didukung');

  if (cdOffset + cdSize > size) throw new Error('direktori ZIP melewati ukuran arsip');
  const cd = await readExact(fh, cdSize, cdOffset);
  const index = new Map();
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) throw new Error('direktori ZIP rusak');
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    const lho = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    // nama ganda: pakai kejadian pertama, sama seperti pembaca native
    if (!index.has(name)) index.set(name, { method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  return index;
}

/** Data mentah sebuah entry (sudah di-inflate bila deflate). Belum dibalik acakannya. */
async function readEntryBytes(fh, e, fileSize) {
  const lh = await readExact(fh, 30, e.lho);
  if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error('header lokal ZIP rusak');
  const dataStart = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (dataStart + e.csize > fileSize) throw new Error('entry melewati ukuran arsip');
  const data = await readExact(fh, e.csize, dataStart);
  if (e.method === 0) return data;
  if (e.method === 8) {
    // batasi keluaran sesuai ukuran yang dideklarasikan: mencegah bomb dekompresi
    const out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
    if (out.length !== e.usize) throw new Error('ukuran hasil dekompresi tidak cocok');
    return out;
  }
  throw new Error(`metode kompresi ZIP ${e.method} belum didukung`);
}

/** Metode kompresi sebuah entry, atau null bila entry tidak ada. Dipakai untuk memutuskan perlu tidaknya salinan. */
async function entryMethod(zipPath, entry) {
  const fh = await fs.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const e = (await readZipIndex(fh, size)).get(entry);
    return e ? e.method : null;
  } finally {
    await fh.close();
  }
}

/**
 * Audio biasa (mis. MP3) dari entry .ritm yang terkompresi, dengan acakan sudah dibalik.
 * Memverifikasi SHA-256 terhadap integrity.json (dihitung atas data yang diacak, seperti saat arsip dibuat).
 */
async function readRitmAudio(zipPath, entry, scrambled) {
  const fh = await fs.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const index = await readZipIndex(fh, size);
    const e = index.get(entry);
    if (!e) throw new Error(`entry tidak ditemukan: ${entry}`);
    const raw = await readEntryBytes(fh, e, size);

    // verifikasi tertutup: tanpa integrity.json, atau tanpa hash untuk entry ini, audio ditolak
    const integ = index.get(INTEGRITY_PATH);
    if (!integ) throw new Error('integrity.json tidak ada di arsip');
    const doc = JSON.parse((await readEntryBytes(fh, integ, size)).toString('utf8'));
    const want = doc?.files?.[entry];
    if (typeof want !== 'string') throw new Error(`hash untuk ${entry} tidak tercatat`);
    const got = crypto.createHash('sha256').update(raw).digest('hex');
    if (got !== want) throw new Error('hash entry tidak cocok dengan integrity.json');
    return scrambled ? xorScramble(raw, entry) : raw;
  } finally {
    await fh.close();
  }
}

module.exports = { entryMethod, readRitmAudio, xorScramble, scrambleSeed, SCRAMBLE_XOR_V1 };
