import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { checkIntegrity } from '../src/format/integrity';
import { sha256Hex } from '../src/format/sha256';
import { SIGNATURE_PATH } from '../src/format/signing';

const te = new TextEncoder();
const enc = (s: string) => te.encode(s);

// kunci uji — hanya untuk tes, tidak pernah ditulis ke repo
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubRaw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64');
const TRUST = { 'test-key': pubRaw };

function signedArchive(tamperBody?: string) {
  const files: Record<string, Uint8Array> = {
    manifest: enc('{"title":"x"}'),
    'audio/01.flac': enc('AUDIO'),
  };
  const integrityBytes = enc(JSON.stringify({
    algorithm: 'sha256',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256Hex(v)])),
  }));
  const integritySha = sha256Hex(integrityBytes);
  const sig = sign(null, Buffer.from(integritySha, 'utf8'), privateKey).toString('base64');
  files['integrity.json'] = integrityBytes;
  files[SIGNATURE_PATH] = enc(JSON.stringify({ alg: 'ed25519', keyId: 'test-key', integritySha256: integritySha, signature: sig }));
  if (tamperBody !== undefined) files['audio/01.flac'] = enc(tamperBody);
  return files;
}

describe('verifikasi tanda tangan', () => {
  it('rilisan bertanda tangan valid → verified', () => {
    const r = checkIntegrity(signedArchive(), TRUST);
    expect(r.status).toBe('verified');
    expect(r.keyId).toBe('test-key');
  });

  it('kunci tidak dikenal → unsigned (tidak bisa diverifikasi)', () => {
    expect(checkIntegrity(signedArchive(), {}).status).toBe('unsigned');
  });

  it('isi diubah → tampered (hash entry tidak cocok)', () => {
    const r = checkIntegrity(signedArchive('DIUBAH'), TRUST);
    expect(r.status).toBe('tampered');
    expect(r.mismatched).toContain('audio/01.flac');
  });

  it('signature.json diubah (integritySha256 tidak cocok) → tampered', () => {
    const f = signedArchive();
    const s = JSON.parse(new TextDecoder().decode(f[SIGNATURE_PATH]!));
    s.integritySha256 = '0'.repeat(64);
    f[SIGNATURE_PATH] = enc(JSON.stringify(s));
    expect(checkIntegrity(f, TRUST).status).toBe('tampered');
  });

  it('tanda tangan rusak → tampered', () => {
    const f = signedArchive();
    const s = JSON.parse(new TextDecoder().decode(f[SIGNATURE_PATH]!));
    const raw = Buffer.from(s.signature, 'base64');
    raw[0] = raw[0]! ^ 0x01;
    s.signature = raw.toString('base64');
    f[SIGNATURE_PATH] = enc(JSON.stringify(s));
    expect(checkIntegrity(f, TRUST).status).toBe('tampered');
  });

  it('signature.json rusak / format salah → tampered', () => {
    const f = signedArchive();
    f[SIGNATURE_PATH] = enc('{bukan json');
    expect(checkIntegrity(f, TRUST).status).toBe('tampered');
  });

  it('tanpa signature.json → unsigned', () => {
    const f = signedArchive();
    delete f[SIGNATURE_PATH];
    expect(checkIntegrity(f, TRUST).status).toBe('unsigned');
  });
});
