import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519Verify } from '../src/format/ed25519';

const newKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { pub: new Uint8Array(spki.subarray(spki.length - 32)), priv: privateKey };
};

describe('ed25519 verify (JS murni)', () => {
  it('menerima tanda tangan dari Node crypto (beberapa kunci dan pesan)', () => {
    for (let k = 0; k < 4; k++) {
      const { pub, priv } = newKey();
      for (const len of [0, 1, 40, 64, 200]) {
        const msg = new Uint8Array(len).map((_, i) => (i * 31 + k) & 0xff);
        const sig = new Uint8Array(nodeSign(null, msg, priv));
        expect(ed25519Verify(pub, msg, sig), `kunci ${k}, panjang ${len}`).toBe(true);
      }
    }
  });

  it('menolak pesan yang diubah', () => {
    const { pub, priv } = newKey();
    const msg = new TextEncoder().encode('integritySha256-contoh');
    const sig = new Uint8Array(nodeSign(null, msg, priv));
    const bad = new Uint8Array(msg);
    bad[3] ^= 1;
    expect(ed25519Verify(pub, bad, sig)).toBe(false);
  });

  it('menolak tanda tangan yang diubah', () => {
    const { pub, priv } = newKey();
    const msg = new TextEncoder().encode('pesan');
    const sig = new Uint8Array(nodeSign(null, msg, priv));
    for (const i of [0, 17, 40, 63]) {
      const bad = new Uint8Array(sig);
      bad[i] ^= 0x10;
      expect(ed25519Verify(pub, msg, bad), `byte ${i}`).toBe(false);
    }
  });

  it('menolak kunci publik dari pasangan lain', () => {
    const a = newKey();
    const b = newKey();
    const msg = new TextEncoder().encode('pesan');
    const sig = new Uint8Array(nodeSign(null, msg, a.priv));
    expect(ed25519Verify(b.pub, msg, sig)).toBe(false);
  });

  it('menolak ukuran tidak valid tanpa melempar error', () => {
    expect(ed25519Verify(new Uint8Array(31), new Uint8Array(1), new Uint8Array(64))).toBe(false);
    expect(ed25519Verify(new Uint8Array(32), new Uint8Array(1), new Uint8Array(63))).toBe(false);
  });
});
