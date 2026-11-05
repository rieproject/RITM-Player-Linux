import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as fflate from 'fflate';
import { parseRitmBytes, sha256Hex } from '../src';

describe('sha256 murni JS', () => {
  it('vektor standar NIST', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('cocok dengan Node crypto untuk berbagai panjang (sekitar batas blok 55/56/64/119/120)', () => {
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 65537]) {
      const data = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(sha256Hex(data), `panjang ${n}`).toBe(expected);
    }
  });
});

// ---- arsip uji ----
const FLAC = (() => { const b = new Uint8Array(512); b.set([...'fLaC'].map((c) => c.charCodeAt(0))); for (let i = 4; i < 512; i++) b[i] = (i * 17) & 0xff; return b; })();
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const manifestText = () => JSON.stringify({
  format: 'ritm',
  formatVersion: 1,
  title: 'Demo',
  artist: 'RITM',
  tracks: [{ trackNumber: 1, title: 'Satu', audio: { path: 'audio/01.flac', mime: 'audio/flac', codec: 'flac', lossless: true } }],
  booklet: { cover: 'booklet/cover.jpg' },
});

/** Rakit arsip; integrity: 'ok' menghitung hash yang benar, 'none' tanpa integrity.json, atau string JSON mentah. */
function buildZip(opts: { integrity?: 'ok' | 'none' | string; extra?: Record<string, Uint8Array>; audio?: Uint8Array } = {}) {
  // file asli (yang dihash saat pengemasan)
  const base: Record<string, Uint8Array> = {
    'audio/01.flac': opts.audio ?? FLAC,
    'booklet/cover.jpg': JPG,
  };
  const manifest = fflate.strToU8(manifestText());
  const z: fflate.Zippable = {
    mimetype: [fflate.strToU8('application/vnd.ritm+zip'), { level: 0 }],
    'manifest.json': manifest,
  };
  if (opts.integrity !== 'none') {
    let text: string;
    if (opts.integrity === undefined || opts.integrity === 'ok') {
      const hashes: Record<string, string> = { 'manifest.json': sha256Hex(manifest) };
      for (const [p, d] of Object.entries(base)) hashes[p] = sha256Hex(d);
      text = JSON.stringify({ algorithm: 'sha256', files: hashes });
    } else {
      text = opts.integrity;
    }
    z['integrity.json'] = fflate.strToU8(text);
  }
  Object.assign(z, base, opts.extra ?? {}); // entry tambahan ditulis setelah hash dihitung
  return fflate.zipSync(z);
}

const store = () => ({ createUrl: (_b: Blob) => 'blob:test' });

describe('verifikasi integritas', () => {
  it('rilisan lama tanpa integrity.json → unsigned, hasIntegrity false', () => {
    const r = parseRitmBytes(buildZip({ integrity: 'none' }), store()).state.integrity!;
    expect(r).toEqual({ status: 'unsigned', hasIntegrity: false, mismatched: [] });
  });

  it('arsip utuh → unsigned, semua hash cocok', () => {
    const r = parseRitmBytes(buildZip(), store()).state.integrity!;
    expect(r).toEqual({ status: 'unsigned', hasIntegrity: true, mismatched: [] });
  });

  it('satu byte audio diubah → tampered dan entry yang rusak disebut', () => {
    const audio = new Uint8Array(FLAC);
    // hash dihitung dari audio asli, lalu isi diubah setelahnya
    const zip = buildZip();
    const files = fflate.unzipSync(zip);
    const tampered = new Uint8Array(files['audio/01.flac']!);
    tampered[300] ^= 0x01;
    const rebuilt = fflate.zipSync({
      mimetype: [fflate.strToU8('application/vnd.ritm+zip'), { level: 0 }],
      'manifest.json': files['manifest.json']!,
      'integrity.json': files['integrity.json']!,
      'audio/01.flac': tampered,
      'booklet/cover.jpg': files['booklet/cover.jpg']!,
    });
    audio.set(tampered);
    const r = parseRitmBytes(rebuilt, store()).state.integrity!;
    expect(r.status).toBe('tampered');
    expect(r.mismatched).toEqual(['audio/01.flac']);
  });

  it('entry tambahan setelah pengemasan → tampered', () => {
    const r = parseRitmBytes(buildZip({ extra: { 'booklet/extra.jpg': JPG } }), store()).state.integrity!;
    expect(r.status).toBe('tampered');
    expect(r.mismatched).toContain('booklet/extra.jpg');
  });

  it('integrity.json rusak → tampered', () => {
    const r = parseRitmBytes(buildZip({ integrity: '{ rusak' }), store()).state.integrity!;
    expect(r.status).toBe('tampered');
    expect(r.mismatched).toEqual(['integrity.json']);
  });

  it('entry yang tercatat tetapi tidak ada → tampered', () => {
    const hashes = { 'manifest.json': sha256Hex(fflate.strToU8(manifestText())), 'audio/01.flac': sha256Hex(FLAC), 'booklet/cover.jpg': sha256Hex(JPG), 'gallery/99.jpg': sha256Hex(JPG) };
    const r = parseRitmBytes(buildZip({ integrity: JSON.stringify({ algorithm: 'sha256', files: hashes }) }), store()).state.integrity!;
    expect(r.status).toBe('tampered');
    expect(r.mismatched).toContain('gallery/99.jpg');
  });

  it('tampered tetap bisa diputar: parser tidak melempar error', () => {
    const r = parseRitmBytes(buildZip({ extra: { 'booklet/extra.jpg': JPG } }), store());
    expect(r.state.tracks).toHaveLength(1);
  });
});
