/** Nama entry tanda tangan (dibuat server saat ingest). Tidak ikut di-hash oleh integrity.json. */
export const SIGNATURE_PATH = 'signature.json';

/**
 * Kunci publik server yang dipercaya player: keyId → kunci publik Ed25519 mentah 32 byte (base64).
 * Diisi setelah kunci dibuat di server (lihat ritm-server/scripts/gen-signing-key.mjs).
 * Kosong = tidak ada rilisan yang dianggap "verified".
 */
export const TRUSTED_SIGNING_KEYS: Record<string, string> = {
  '45e0723dc0472774': 'o0ylRTXRkTpHFGX2Gxx8jgSIOweGX9UKP1iYws1g3Ro=',
};

/** Isi signature.json. Tanda tangan mencakup integritySha256 (UTF-8), yang mengikat seluruh isi arsip. */
export interface SignatureFile {
  alg: 'ed25519';
  keyId: string;
  integritySha256: string;
  signature: string; // base64, 64 byte
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
