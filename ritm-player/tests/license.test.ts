import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  canonicalJson,
  checkLicense,
  formatLicenseSignature,
  isMaskedLicensee,
  licensePayload,
  licensedAudioPaths,
  sha256Hex,
  validateManifest,
  type RitmManifest,
} from '../src';

const enc = (s: string) => new TextEncoder().encode(s);
const audio = enc('RIFFfake-audio-bytes');

function baseManifest(): RitmManifest {
  return {
    format: 'ritm',
    formatVersion: 1,
    title: 'Uji',
    artist: 'Uji',
    tracks: [{ trackNumber: 1, title: 'A', audio: { path: 'audio/01.wav', mime: 'audio/wav', codec: 'wav', lossless: true } as RitmManifest['tracks'][number]['audio'] }],
  } as RitmManifest;
}

/** Menandatangani payload seperti server: kunci Ed25519 Node, lalu format field signature. */
function issue(manifest: RitmManifest, files: Record<string, Uint8Array>, privateKey: import('node:crypto').KeyObject, keyId: string): RitmManifest {
  const pending = { ...manifest, license: { orderId: 'ord_1', licensee: 'a***e@gmail.com', issuedAt: '2026-11-01T00:00:00.000Z', issuer: 'RITM', terms: 'personal-v1', signature: '' } } as RitmManifest;
  const sig = nodeSign(null, licensePayload(pending, files), privateKey).toString('base64');
  return { ...pending, license: { ...pending.license!, signature: formatLicenseSignature(keyId, sig) } };
}

describe('canonicalJson', () => {
  it('mengurutkan kunci secara rekursif dan membuang undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined, x: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[{"x":2,"z":1}]},"b":1}');
  });
});

describe('licensedAudioPaths', () => {
  it('menyertakan audio utama dan karaoke, tanpa duplikat', () => {
    const m = baseManifest();
    m.tracks.push({ trackNumber: 2, title: 'B', audio: { path: 'audio/02.wav' } as never, karaoke: { path: 'audio/02-k.wav' } as never } as never);
    m.tracks.push({ trackNumber: 3, title: 'C', audio: { path: 'audio/01.wav' } as never } as never);
    expect(licensedAudioPaths(m)).toEqual(['audio/01.wav', 'audio/02-k.wav', 'audio/02.wav']);
  });
});

describe('checkLicense', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = sha256Hex(raw).slice(0, 16);
  const trusted = { [keyId]: Buffer.from(raw).toString('base64') };
  const files = { 'audio/01.wav': audio };

  it('tanpa blok license → none', () => {
    expect(checkLicense(baseManifest(), files, trusted).status).toBe('none');
  });

  it('tanda tangan dari kunci Node dikenali player → verified', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense(licensed, files, trusted).status).toBe('verified');
  });

  it('judul diubah setelah diterbitkan → invalid', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense({ ...licensed, title: 'Palsu' }, files, trusted).status).toBe('invalid');
  });

  it('audio ditukar setelah diterbitkan → invalid', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense(licensed, { 'audio/01.wav': enc('lain') }, trusted).status).toBe('invalid');
  });

  it('identitas pembeli diganti → invalid', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense({ ...licensed, license: { ...licensed.license!, licensee: 'b***x@gmail.com' } }, files, trusted).status).toBe('invalid');
  });

  it('keyId tidak dikenal → unknown-key, bukan verified', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense(licensed, files, {}).status).toBe('unknown-key');
  });

  it('format signature salah → invalid', () => {
    const licensed = issue(baseManifest(), files, privateKey, keyId);
    expect(checkLicense({ ...licensed, license: { ...licensed.license!, signature: 'ed25519:xyz' } }, files, trusted).status).toBe('invalid');
  });
});

describe('isMaskedLicensee', () => {
  it('menerima email tersamarkan, menolak email lengkap', () => {
    expect(isMaskedLicensee('a***e@gmail.com')).toBe(true);
    expect(isMaskedLicensee('Nama Pembeli')).toBe(true);
    expect(isMaskedLicensee('ahmad@gmail.com')).toBe(false);
  });
});

describe('validasi blok license di manifest', () => {
  const withLicense = (license: unknown) => ({ ...baseManifest(), license });
  const good = { orderId: 'ord_1', licensee: 'a***e@gmail.com', issuedAt: '2026-11-01T00:00:00.000Z', issuer: 'RITM', signature: 'ed25519:0123456789abcdef:AAAA' };

  it('license lengkap dan tersamarkan diterima', () => {
    expect(validateManifest(withLicense(good)).ok).toBe(true);
  });

  it('email lengkap ditolak (minimisasi data pribadi)', () => {
    const res = validateManifest(withLicense({ ...good, licensee: 'ahmad@gmail.com' }));
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.field)).toContain('license.licensee');
  });

  it('field wajib kosong ditolak', () => {
    const res = validateManifest(withLicense({ ...good, orderId: '' }));
    expect(res.errors.map((e) => e.field)).toContain('license.orderId');
  });
});
