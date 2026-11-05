import type { IntegrityReport } from '../types/ritm';
import { INTEGRITY_PATH } from './constants';
import { ed25519Verify } from './ed25519';
import { SIGNATURE_PATH, TRUSTED_SIGNING_KEYS, b64ToBytes, type SignatureFile } from './signing';
import { sha256Hex } from './sha256';

/** Entry yang tidak dihitung di integrity.json (lihat spesifikasi integritas). */
const EXCLUDED = new Set(['mimetype', INTEGRITY_PATH, SIGNATURE_PATH]);

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Periksa isi arsip.
 * 1. integrity.json: hash setiap entry harus cocok; entry hilang/tambahan/rusak → tampered.
 * 2. signature.json (opsional): hanya bila integrity.json cocok.
 *    - keyId dikenal dan tanda tangan valid → verified
 *    - keyId tidak dikenal → unsigned (tidak bisa diverifikasi)
 *    - tanda tangan tidak valid, integritySha256 tidak cocok, atau file rusak → tampered
 * Rilisan tanpa integrity.json (lama) → unsigned, hasIntegrity: false.
 */
export function checkIntegrity(files: Record<string, Uint8Array>, trusted: Record<string, string> = TRUSTED_SIGNING_KEYS): IntegrityReport {
  const raw = files[INTEGRITY_PATH];
  if (!raw) return { status: 'unsigned', hasIntegrity: false, mismatched: [] };

  let listed: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(td.decode(raw)) as { algorithm?: unknown; files?: unknown };
    if (parsed.algorithm === 'sha256' && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      listed = parsed.files as Record<string, unknown>;
    }
  } catch {
    listed = null;
  }
  if (!listed) return { status: 'tampered', hasIntegrity: true, mismatched: [INTEGRITY_PATH] };

  const mismatched: string[] = [];
  for (const [path, expected] of Object.entries(listed)) {
    const data = files[path];
    if (!data || typeof expected !== 'string' || sha256Hex(data) !== expected) mismatched.push(path);
  }
  // entry yang ditambahkan setelah pengemasan juga dianggap perubahan
  for (const path of Object.keys(files)) {
    if (!EXCLUDED.has(path) && !(path in listed)) mismatched.push(path);
  }
  if (mismatched.length) return { status: 'tampered', hasIntegrity: true, mismatched };

  // ---- tanda tangan ----
  const rawSig = files[SIGNATURE_PATH];
  if (!rawSig) return { status: 'unsigned', hasIntegrity: true, mismatched: [] };

  let sig: SignatureFile | null = null;
  try {
    const s = JSON.parse(td.decode(rawSig)) as Partial<SignatureFile>;
    if (s.alg === 'ed25519' && typeof s.keyId === 'string' && typeof s.integritySha256 === 'string' && typeof s.signature === 'string') {
      sig = s as SignatureFile;
    }
  } catch {
    sig = null;
  }
  const bad: IntegrityReport = { status: 'tampered', hasIntegrity: true, mismatched: [SIGNATURE_PATH] };
  if (!sig) return bad;
  if (sha256Hex(raw) !== sig.integritySha256) return bad;

  const pubB64 = trusted[sig.keyId];
  if (!pubB64) return { status: 'unsigned', hasIntegrity: true, mismatched: [], keyId: sig.keyId };

  let ok = false;
  try {
    ok = ed25519Verify(b64ToBytes(pubB64), te.encode(sig.integritySha256), b64ToBytes(sig.signature));
  } catch {
    ok = false;
  }
  return ok ? { status: 'verified', hasIntegrity: true, mismatched: [], keyId: sig.keyId } : bad;
}
