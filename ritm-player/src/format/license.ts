import type { RitmLicense, RitmManifest } from '../types/ritm';
import { ed25519Verify } from './ed25519';
import { sha256Hex } from './sha256';
import { b64ToBytes } from './signing';

/**
 * Kunci publik penandatangan LISENSI (terpisah dari kunci rilisan, lihat BSD §6 dan IPD 2.7).
 * Kosong = belum ada lisensi yang bisa diverifikasi, jadi UI tidak boleh menampilkan "Dilisensikan untuk".
 */
export const TRUSTED_LICENSE_KEYS: Record<string, string> = {};

/** Format tanda tangan lisensi: ed25519:<keyId 16 hex>:<signature base64, 64 byte>. */
const LICENSE_SIGNATURE = /^ed25519:([0-9a-f]{16}):([A-Za-z0-9+/]+={0,2})$/;

export type LicenseStatus =
  | 'none'         // tidak ada blok license
  | 'verified'     // tanda tangan valid, isi manifest dan audio tidak berubah
  | 'unknown-key'  // keyId tidak dikenal player ini
  | 'invalid';     // format salah, tanda tangan tidak cocok, atau isi berubah

export interface LicenseCheck {
  status: LicenseStatus;
  license?: RitmLicense;
  keyId?: string;
}

const te = new TextEncoder();

/**
 * JSON kanonik: kunci objek diurutkan secara rekursif, field bernilai undefined dibuang.
 * Server dan player memakai fungsi yang sama, jadi bytes yang ditandatangani selalu identik.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const body = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Jalur semua file audio yang diikat ke lisensi (lagu dan versi karaoke). */
export function licensedAudioPaths(manifest: RitmManifest): string[] {
  const paths = new Set<string>();
  for (const t of manifest.tracks) {
    paths.add(t.audio.path);
    if (t.karaoke) paths.add(t.karaoke.path);
  }
  return [...paths].sort();
}

/**
 * Pesan yang ditandatangani: manifest tanpa license.signature, ditambah sha256 setiap file audio.
 * Mengikat lisensi ke identitas pembeli DAN ke byte audio, sehingga audio tidak bisa ditukar.
 * Melempar bila file audio yang dirujuk tidak ada.
 */
export function licensePayload(manifest: RitmManifest, files: Record<string, Uint8Array>): Uint8Array {
  const { license, ...rest } = manifest;
  const audio: Record<string, string> = {};
  for (const path of licensedAudioPaths(manifest)) {
    const data = files[path];
    if (!data) throw new Error(`file audio tidak ada: ${path}`);
    audio[path] = sha256Hex(data);
  }
  const body = license ? { ...license, signature: undefined } : undefined;
  return te.encode(canonicalJson({ manifest: { ...rest, license: body }, audio }));
}

/** Susun nilai field signature dari keyId dan bytes tanda tangan mentah (base64). */
export function formatLicenseSignature(keyId: string, signatureB64: string): string {
  return `ed25519:${keyId}:${signatureB64}`;
}

/**
 * Periksa blok license. Tidak menggantikan integrity.json: pemanggil tetap memeriksa integritas arsip.
 * Hanya kunci dalam `trusted` yang bisa menghasilkan "verified".
 */
export function checkLicense(
  manifest: RitmManifest,
  files: Record<string, Uint8Array>,
  trusted: Record<string, string> = TRUSTED_LICENSE_KEYS,
): LicenseCheck {
  const license = manifest.license;
  if (!license) return { status: 'none' };

  const m = LICENSE_SIGNATURE.exec(license.signature);
  if (!m) return { status: 'invalid', license };
  const keyId = m[1]!;

  const pubB64 = trusted[keyId];
  if (!pubB64) return { status: 'unknown-key', license, keyId };

  let ok = false;
  try {
    ok = ed25519Verify(b64ToBytes(pubB64), licensePayload(manifest, files), b64ToBytes(m[2]!));
  } catch {
    ok = false;
  }
  return { status: ok ? 'verified' : 'invalid', license, keyId };
}

/** Data pribadi minimal: licensee harus berupa email yang sudah disamarkan (atau bukan email sama sekali). */
export function isMaskedLicensee(licensee: string): boolean {
  return !licensee.includes('@') || licensee.includes('***');
}
