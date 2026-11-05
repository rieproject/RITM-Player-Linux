import { describe, expect, it } from 'vitest';
import * as fflate from 'fflate';
import { parseRitmBytes, sha256Hex } from '../src';
import { fnv1a32, scrambleSeed, unscrambleAudio, xorScramble, SCRAMBLE_KEY } from '../src/format/scramble';
import { validateManifest } from '../src/format/validate';

describe('pengacakan xor-v1', () => {
  it('FNV-1a vektor standar', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('konstanta platform = "RITM"', () => {
    expect(SCRAMBLE_KEY).toBe(0x5249544d);
  });

  it('vektor tetap (harus sama dengan implementasi native C++)', () => {
    const d = new Uint8Array(10).map((_, i) => i);
    expect(scrambleSeed('audio/01.flac').toString(16)).toBe('68042f9a');
    expect(Array.from(xorScramble(d, 'audio/01.flac'))).toEqual([0x41, 0x34, 0x16, 0x50, 0x7b, 0x89, 0x35, 0x65, 0x89, 0xd8]);
  });

  it('simetris: acak lalu acak lagi = data asli, untuk berbagai panjang', () => {
    for (const n of [0, 1, 3, 4, 5, 7, 8, 1000, 65537]) {
      const data = new Uint8Array(n).map((_, i) => (i * 97 + 3) & 0xff);
      const s = xorScramble(data, 'audio/02.wav');
      if (n > 0) expect(Buffer.from(s).equals(Buffer.from(data))).toBe(false);
      expect(Buffer.from(xorScramble(s, 'audio/02.wav')).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('path berbeda → keystream berbeda', () => {
    const d = new Uint8Array(64);
    expect(Buffer.from(xorScramble(d, 'audio/01.flac')).equals(Buffer.from(xorScramble(d, 'karaoke/01.flac')))).toBe(false);
  });

  it('tanpa penanda scramble, data dikembalikan apa adanya', () => {
    const d = new Uint8Array([1, 2, 3]);
    expect(unscrambleAudio(d, { path: 'audio/01.flac' })).toBe(d);
  });

  it('validasi: scramble selain "xor-v1" ditolak', () => {
    const files: Record<string, number> = { 'audio/01.flac': 1000 };
    const m = (scramble: unknown) => ({
      format: 'ritm',
      formatVersion: 1,
      title: 'Uji',
      artist: 'Uji',
      tracks: [{ trackNumber: 1, title: 'Lagu', audio: { path: 'audio/01.flac', mime: 'audio/flac', codec: 'flac', lossless: true, scramble } }],
    });
    expect(validateManifest(m('xor-v1'), { size: (p) => files[p] }).ok).toBe(true);
    expect(validateManifest(m('rot13'), { size: (p) => files[p] }).ok).toBe(false);
  });
});

// ---- arsip uji dengan audio teracak ----
const FLAC = (() => {
  const b = new Uint8Array(512);
  b.set([...'fLaC'].map((c) => c.charCodeAt(0)));
  for (let i = 4; i < 512; i++) b[i] = (i * 17) & 0xff;
  return b;
})();

function buildScrambledZip(stored: Uint8Array, scramble: 'xor-v1' | undefined) {
  const audio = { path: 'audio/01.flac', mime: 'audio/flac', codec: 'flac', lossless: true, ...(scramble ? { scramble } : {}) };
  const manifest = fflate.strToU8(JSON.stringify({ format: 'ritm', formatVersion: 1, title: 'Acak', artist: 'RITM', tracks: [{ trackNumber: 1, title: 'Satu', audio }] }));
  const hashes = { 'manifest.json': sha256Hex(manifest), 'audio/01.flac': sha256Hex(stored) };
  return fflate.zipSync({
    mimetype: [fflate.strToU8('application/vnd.ritm+zip'), { level: 0 }],
    'manifest.json': manifest,
    'integrity.json': fflate.strToU8(JSON.stringify({ algorithm: 'sha256', files: hashes })),
    'audio/01.flac': stored,
  });
}

async function audioOf(bytes: Uint8Array): Promise<Uint8Array> {
  const blobs: Blob[] = [];
  const parsed = parseRitmBytes(bytes, { createUrl: (b: Blob) => (blobs.push(b), 'blob:x') });
  expect(parsed.state.tracks[0]).toBeDefined();
  return new Uint8Array(await blobs[0]!.arrayBuffer());
}

describe('arsip dengan audio teracak', () => {
  it('audio yang diacak dibalik saat dibaca: codec terdeteksi dan isi sama dengan asli', async () => {
    const stored = xorScramble(FLAC, 'audio/01.flac');
    const zip = buildScrambledZip(stored, 'xor-v1');
    expect(Buffer.from(await audioOf(zip)).equals(Buffer.from(FLAC))).toBe(true);
  });

  it('integritas dihitung dari byte yang tersimpan (teracak) → tidak TAMPERED', () => {
    const zip = buildScrambledZip(xorScramble(FLAC, 'audio/01.flac'), 'xor-v1');
    const st = parseRitmBytes(zip, { createUrl: () => 'blob:x' }).state.integrity;
    expect(st?.status).not.toBe('tampered');
  });

  it('rilisan tanpa penanda tetap diputar apa adanya (kompatibel mundur)', async () => {
    const zip = buildScrambledZip(FLAC, undefined);
    expect(Buffer.from(await audioOf(zip)).equals(Buffer.from(FLAC))).toBe(true);
  });

  it('ekstrak tanpa kunci: byte di dalam arsip bukan audio asli', () => {
    const stored = xorScramble(FLAC, 'audio/01.flac');
    const raw = fflate.unzipSync(buildScrambledZip(stored, 'xor-v1'))['audio/01.flac']!;
    expect(raw[0]).not.toBe(0x66); // 'f' dari 'fLaC'
    expect(Buffer.from(raw).equals(Buffer.from(FLAC))).toBe(false);
  });
});
