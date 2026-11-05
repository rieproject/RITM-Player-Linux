import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/format/validate';

const base = (karaoke?: unknown) => ({
  format: 'ritm',
  formatVersion: 1,
  title: 'Uji',
  artist: 'Uji',
  tracks: [
    {
      trackNumber: 1,
      title: 'Lagu',
      audio: { path: 'audio/01.flac', mime: 'audio/flac', codec: 'flac', lossless: true },
      ...(karaoke === undefined ? {} : { karaoke }),
    },
  ],
});

const karaokeOk = { path: 'karaoke/01.flac', mime: 'audio/flac', codec: 'flac', lossless: true };
const files: Record<string, number> = { 'audio/01.flac': 1000, 'karaoke/01.flac': 900 };
const archive = { size: (p: string) => files[p] };

describe('karaoke (instrumental)', () => {
  it('tanpa karaoke tetap valid (perilaku lama)', () => {
    expect(validateManifest(base(), archive).ok).toBe(true);
  });

  it('karaoke valid diterima', () => {
    const r = validateManifest(base(karaokeOk), archive);
    expect(r.ok).toBe(true);
    expect(r.manifest?.tracks[0]?.karaoke?.path).toBe('karaoke/01.flac');
  });

  it('karaoke harus di folder karaoke/', () => {
    const r = validateManifest(base({ ...karaokeOk, path: 'audio/01.flac' }), archive);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toContain('tracks[0].karaoke.path');
  });

  it('codec tidak cocok dengan mime/lossless ditolak', () => {
    const r = validateManifest(base({ ...karaokeOk, lossless: false }), archive);
    expect(r.errors.map((e) => e.field)).toContain('tracks[0].karaoke.lossless');
  });

  it('karaoke yang tidak ada di arsip ditolak (MISSING_FILE)', () => {
    const r = validateManifest(base({ ...karaokeOk, path: 'karaoke/02.flac' }), archive);
    expect(r.errors.some((e) => e.code === 'MISSING_FILE')).toBe(true);
  });

  it('karaoke memakai path yang sama dengan audio utama ditolak', () => {
    const r = validateManifest(base({ ...karaokeOk, path: 'audio/01.flac' }), archive);
    expect(r.ok).toBe(false);
  });

  it('karaoke harus objek', () => {
    const r = validateManifest(base('karaoke/01.flac'), archive);
    expect(r.ok).toBe(false);
  });
});

import * as fflate from 'fflate';
import { parseRitmBytes } from '../src/engine/ritmContainer';

const enc = (s: string) => new TextEncoder().encode(s);
const FLAC = new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...new Array(60).fill(0)]); // "fLaC" + padding
function makeRitm(withKaraoke: boolean, karaokeBytes: Uint8Array = FLAC) {
  const manifest = {
    ...base(withKaraoke ? karaokeOk : undefined),
  };
  const entries: Record<string, Uint8Array | [Uint8Array, { level: number }]> = {
    mimetype: [enc('application/vnd.ritm+zip'), { level: 0 }],
    'manifest.json': enc(JSON.stringify(manifest)),
    'audio/01.flac': FLAC,
  };
  if (withKaraoke) entries['karaoke/01.flac'] = karaokeBytes;
  return fflate.zipSync(entries);
}
const createUrl = () => 'blob:test';

describe('parser karaoke', () => {
  it('desktop (includeKaraoke): karaoke dimuat sebagai entry + URL', () => {
    const { state } = parseRitmBytes(makeRitm(true), { createUrl, includeKaraoke: true });
    expect(state.tracks[0]!.karaoke).toEqual({ entry: 'karaoke/01.flac', mime: 'audio/flac', url: 'blob:test' });
  });

  it('web player (default): karaoke tidak dimuat', () => {
    const { state } = parseRitmBytes(makeRitm(true), { createUrl });
    expect(state.tracks[0]!.karaoke).toBeUndefined();
  });

  it('tanpa karaoke di manifest: karaoke undefined', () => {
    const { state } = parseRitmBytes(makeRitm(false), { createUrl, includeKaraoke: true });
    expect(state.tracks[0]!.karaoke).toBeUndefined();
  });

  it('isi karaoke tidak sesuai codec yang dideklarasikan: ditolak', () => {
    // "RIFF....WAVE" + padding: codec terdeteksi wav, tidak cocok dengan flac yang dideklarasikan
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...new Array(60).fill(0)]);
    expect(() => parseRitmBytes(makeRitm(true, wav), { createUrl, includeKaraoke: true })).toThrow();
  });
});
