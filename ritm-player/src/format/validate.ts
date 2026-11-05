import { SCRAMBLE_XOR_V1 } from './scramble';
import { isMaskedLicensee } from './license';
import type { RitmAudioCodec, RitmManifest } from '../types/ritm';
import { AUDIO_CODECS, FOLDERS, IMAGE_MIMES, LIMITS, MOOD_PRESETS, RITM_FORMAT_VERSION } from './constants';
import type { RitmIssue } from './errors';

/** Akses minimal ke isi arsip, agar validasi bisa dipakai packager maupun parser. */
export interface ArchiveIndex {
  size(path: string): number | undefined; // undefined = tidak ada
}

export interface ValidationResult {
  ok: boolean;
  manifest?: RitmManifest;
  errors: RitmIssue[];
  warnings: RitmIssue[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Path aman: relatif, slash maju, tanpa "..", di dalam folder yang ditentukan. */
export function checkPath(path: unknown, folder: string, field: string, exts?: string[]): RitmIssue | null {
  if (typeof path !== 'string' || path.length === 0) {
    return { code: 'INVALID_FIELD', field, message: 'path wajib berupa string' };
  }
  const segs = path.split('/');
  if (
    path.length > 255 ||
    !SAFE_PATH.test(path) ||
    path.startsWith('/') ||
    segs.some((s) => s === '' || s === '.' || s === '..') ||
    !path.startsWith(folder) ||
    segs.length !== 2
  ) {
    return { code: 'BAD_PATH', field, message: `path "${path}" harus berbentuk ${folder}<nama-file> tanpa subfolder` };
  }
  if (exts) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (!exts.includes(ext)) {
      return { code: 'BAD_PATH', field, message: `ekstensi .${ext} tidak diizinkan (${exts.join(', ')})` };
    }
  }
  return null;
}

export function validateManifest(raw: unknown, archive?: ArchiveIndex): ValidationResult {
  const errors: RitmIssue[] = [];
  const warnings: RitmIssue[] = [];
  const err = (code: RitmIssue['code'], field: string, message: string) => errors.push({ code, field, message });

  if (!isObj(raw)) {
    err('INVALID_FIELD', '$', 'manifest harus berupa objek JSON');
    return { ok: false, errors, warnings };
  }

  // --- identitas format ---
  if (raw.format !== 'ritm') err('INVALID_FIELD', 'format', 'harus "ritm"');
  const v = raw.formatVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    err('INVALID_FIELD', 'formatVersion', 'harus bilangan bulat ≥ 1');
  } else if (v > RITM_FORMAT_VERSION) {
    err('UNSUPPORTED_VERSION', 'formatVersion', `versi ${v} lebih baru dari yang didukung (${RITM_FORMAT_VERSION})`);
    return { ok: false, errors, warnings }; // jangan tebak struktur versi yang tidak dikenal
  }

  // --- teks rilisan ---
  const text = (key: string, required: boolean) => {
    const val = raw[key];
    if (val === undefined && !required) return;
    if (typeof val !== 'string' || val.trim() === '') err('INVALID_FIELD', key, 'wajib berupa teks tidak kosong');
    else if (val.length > LIMITS.maxTextChars) err('INVALID_FIELD', key, `maksimal ${LIMITS.maxTextChars} karakter`);
  };
  text('title', true);
  text('artist', true);
  text('catalogNumber', false);
  text('genre', false);
  text('label', false);

  if (raw.releaseType !== undefined && !['album', 'ep', 'single'].includes(raw.releaseType as string)) {
    err('INVALID_FIELD', 'releaseType', 'harus "album", "ep", atau "single"');
  }
  if (raw.releaseDate !== undefined) {
    const d = raw.releaseDate;
    const ok = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!ok) err('INVALID_FIELD', 'releaseDate', 'harus tanggal YYYY-MM-DD');
  }

  if (raw.year !== undefined) {
    const y = raw.year;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < 1900 || y > 2100) {
      err('INVALID_FIELD', 'year', 'harus tahun 1900–2100');
    }
  }

  // --- tema ---
  if (raw.theme !== undefined) {
    if (!isObj(raw.theme)) err('INVALID_FIELD', 'theme', 'harus objek');
    else {
      for (const key of ['surfaceColor', 'textColor', 'accentColor'] as const) {
        const c = raw.theme[key];
        if (c !== undefined && (typeof c !== 'string' || !HEX.test(c))) {
          err('INVALID_FIELD', `theme.${key}`, 'harus warna hex #rrggbb');
        }
      }
      const o = raw.theme.surfaceOpacity;
      if (o !== undefined && (typeof o !== 'number' || o < 0.2 || o > 1)) {
        err('INVALID_FIELD', 'theme.surfaceOpacity', 'harus angka 0.2–1');
      }
    }
  }

  // --- tracks ---
  const usedPaths = new Map<string, string>();
  const claimPath = (path: string, field: string) => {
    const prev = usedPaths.get(path);
    if (prev) err('INVALID_FIELD', field, `path "${path}" sudah dipakai di ${prev}`);
    else usedPaths.set(path, field);
  };
  const checkFile = (path: string, field: string, max: number) => {
    if (!archive) return;
    const size = archive.size(path);
    if (size === undefined) err('MISSING_FILE', field, `"${path}" tidak ada di arsip`);
    else if (size > max) err('TOO_LARGE', field, `"${path}" ${size} byte melebihi batas ${max} byte`);
  };

  /** Validasi referensi audio (audio utama atau karaoke): codec, mime, lossless, bitrate, path, ukuran. */
  const checkAudioRef = (raw: unknown, field: string, folder: string) => {
    if (!isObj(raw)) {
      err('INVALID_FIELD', field, 'wajib ada');
      return;
    }
    const a = raw as Record<string, any>;
    const codec = a.codec as RitmAudioCodec;
    const spec = AUDIO_CODECS[codec];
    if (!spec) {
      err('INVALID_FIELD', `${field}.codec`, `harus salah satu: ${Object.keys(AUDIO_CODECS).join(', ')}`);
    } else {
      if (a.mime !== spec.mime) err('INVALID_FIELD', `${field}.mime`, `codec ${codec} wajib mime "${spec.mime}"`);
      if (a.lossless !== spec.lossless) {
        err('INVALID_FIELD', `${field}.lossless`, `codec ${codec} → lossless harus ${spec.lossless}`);
      }
    }
    if (a.bitrate !== undefined && (typeof a.bitrate !== 'number' || a.bitrate < 8 || a.bitrate > 3000)) {
      err('INVALID_FIELD', `${field}.bitrate`, 'harus kbps 8–3000');
    }
    if (a.scramble !== undefined && a.scramble !== SCRAMBLE_XOR_V1) {
      err('INVALID_FIELD', `${field}.scramble`, `harus "${SCRAMBLE_XOR_V1}" bila ada`);
    }
    const exts = spec ? [spec.ext] : undefined;
    const pathIssue = checkPath(a.path, folder, `${field}.path`, exts);
    if (pathIssue) errors.push(pathIssue);
    else {
      claimPath(a.path as string, `${field}.path`);
      checkFile(a.path as string, `${field}.path`, LIMITS.maxTrackBytes);
    }
  };

  const imgExts = [...Object.keys(IMAGE_MIMES), 'jpeg'];
  const backdropFiles = new Set<string>();
  const trackPhotoRefs: { path: string; field: string }[] = [];

  const tracks = raw.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    err('INVALID_FIELD', 'tracks', 'minimal 1 track');
  } else if (tracks.length > LIMITS.maxTracks) {
    err('TOO_LARGE', 'tracks', `maksimal ${LIMITS.maxTracks} track`);
  } else {
    const numbers = new Set<number>();
    tracks.forEach((t, i) => {
      const f = `tracks[${i}]`;
      if (!isObj(t)) return err('INVALID_FIELD', f, 'harus objek');

      const n = t.trackNumber;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > LIMITS.maxTracks) {
        err('INVALID_FIELD', `${f}.trackNumber`, 'harus bilangan bulat 1–99');
      } else if (numbers.has(n)) {
        err('INVALID_FIELD', `${f}.trackNumber`, `nomor ${n} dipakai lebih dari sekali`);
      } else numbers.add(n);

      if (typeof t.title !== 'string' || t.title.trim() === '') err('INVALID_FIELD', `${f}.title`, 'wajib berupa teks');
      else if (t.title.length > LIMITS.maxTextChars) err('INVALID_FIELD', `${f}.title`, 'terlalu panjang');
      if (t.artist !== undefined && (typeof t.artist !== 'string' || t.artist.trim() === '')) {
        err('INVALID_FIELD', `${f}.artist`, 'harus teks tidak kosong');
      }
      if (t.duration !== undefined && (typeof t.duration !== 'number' || !(t.duration > 0))) {
        err('INVALID_FIELD', `${f}.duration`, 'harus angka detik > 0');
      }

      // audio
      checkAudioRef(t.audio, `${f}.audio`, FOLDERS.audio);

      // karaoke (instrumental, desktop saja): aturan sama dengan audio, folder karaoke/
      if (t.karaoke !== undefined) checkAudioRef(t.karaoke, `${f}.karaoke`, FOLDERS.karaoke);

      // lyrics
      if (t.lyrics !== undefined) {
        if (!isObj(t.lyrics)) err('INVALID_FIELD', `${f}.lyrics`, 'harus objek { path }');
        else {
          const pathIssue = checkPath(t.lyrics.path, FOLDERS.lyrics, `${f}.lyrics.path`, ['lrc']);
          if (pathIssue) errors.push(pathIssue);
          else {
            claimPath(t.lyrics.path as string, `${f}.lyrics.path`);
            checkFile(t.lyrics.path as string, `${f}.lyrics.path`, LIMITS.maxLyricsBytes);
          }
        }
      }

      // visual per lagu
      if (t.visual !== undefined) {
        const vf = `${f}.visual`;
        const vis = t.visual;
        if (!isObj(vis)) err('INVALID_FIELD', vf, 'harus objek { photos?, mood? }');
        else {
          if (vis.photos !== undefined) {
            const ph = vis.photos;
            if (!Array.isArray(ph)) err('INVALID_FIELD', `${vf}.photos`, 'harus array');
            else if (ph.length > LIMITS.maxTrackPhotos) err('TOO_LARGE', `${vf}.photos`, `maksimal ${LIMITS.maxTrackPhotos} foto per lagu`);
            else {
              const seen = new Set<string>();
              ph.forEach((item, j) => {
                const pf = `${vf}.photos[${j}]`;
                if (!isObj(item)) return err('INVALID_FIELD', pf, 'harus objek { path, caption? }');
                const pathIssue = checkPath(item.path, FOLDERS.gallery, `${pf}.path`, imgExts);
                if (pathIssue) errors.push(pathIssue);
                else if (seen.has(item.path as string)) err('INVALID_FIELD', `${pf}.path`, 'foto dipakai dua kali di lagu yang sama');
                else {
                  seen.add(item.path as string);
                  trackPhotoRefs.push({ path: item.path as string, field: `${pf}.path` });
                }
                const c = item.caption;
                if (c !== undefined && (typeof c !== 'string' || c.length > LIMITS.maxCaptionChars)) {
                  err('INVALID_FIELD', `${pf}.caption`, `teks maksimal ${LIMITS.maxCaptionChars} karakter`);
                }
              });
            }
          }
          if (vis.mood !== undefined) {
            const m = vis.mood;
            if (!isObj(m)) err('INVALID_FIELD', `${vf}.mood`, 'harus objek { preset, colors, energy? }');
            else {
              if (!MOOD_PRESETS.includes(m.preset as (typeof MOOD_PRESETS)[number])) {
                err('INVALID_FIELD', `${vf}.mood.preset`, `harus salah satu: ${MOOD_PRESETS.join(', ')}`);
              }
              const cs = m.colors;
              if (!Array.isArray(cs) || cs.length < 1 || cs.length > LIMITS.maxMoodColors || cs.some((c) => typeof c !== 'string' || !HEX.test(c))) {
                err('INVALID_FIELD', `${vf}.mood.colors`, `harus 1–${LIMITS.maxMoodColors} warna hex #rrggbb`);
              }
              if (m.energy !== undefined && (typeof m.energy !== 'number' || m.energy < 0 || m.energy > 1)) {
                err('INVALID_FIELD', `${vf}.mood.energy`, 'harus angka 0–1');
              }
            }
          }
        }
      }
    });
  }

  // --- booklet ---
  if (raw.booklet !== undefined) {
    if (!isObj(raw.booklet)) err('INVALID_FIELD', 'booklet', 'harus objek');
    else {
      const imgExts = [...Object.keys(IMAGE_MIMES), 'jpeg'];
      for (const key of ['cover', 'spread', 'thumb'] as const) {
        const p = raw.booklet[key];
        if (p === undefined) continue;
        const pathIssue = checkPath(p, FOLDERS.booklet, `booklet.${key}`, imgExts);
        if (pathIssue) errors.push(pathIssue);
        else {
          claimPath(p as string, `booklet.${key}`);
          checkFile(p as string, `booklet.${key}`, LIMITS.maxImageBytes);
        }
      }
      const pages = raw.booklet.pages;
      if (pages !== undefined) {
        if (!Array.isArray(pages)) err('INVALID_FIELD', 'booklet.pages', 'harus array');
        else if (pages.length > LIMITS.maxBookletPages) {
          err('TOO_LARGE', 'booklet.pages', `maksimal ${LIMITS.maxBookletPages} halaman`);
        } else {
          pages.forEach((p, i) => {
            const field = `booklet.pages[${i}]`;
            const pathIssue = checkPath(p, FOLDERS.booklet, field, imgExts);
            if (pathIssue) errors.push(pathIssue);
            else {
              claimPath(p as string, field);
              checkFile(p as string, field, LIMITS.maxImageBytes);
            }
          });
        }
      }
      const e = raw.booklet.editorialText;
      if (e !== undefined) {
        if (typeof e !== 'string') err('INVALID_FIELD', 'booklet.editorialText', 'harus teks');
        else if (e.length > LIMITS.maxEditorialChars) {
          err('TOO_LARGE', 'booklet.editorialText', `maksimal ${LIMITS.maxEditorialChars} karakter`);
        }
      }
    }
  }

  // --- galeri ---
  if (raw.gallery !== undefined) {
    const g = raw.gallery;
    if (!Array.isArray(g)) err('INVALID_FIELD', 'gallery', 'harus array');
    else if (g.length > LIMITS.maxGalleryImages) err('TOO_LARGE', 'gallery', `maksimal ${LIMITS.maxGalleryImages} foto`);
    else {
      g.forEach((item, i) => {
        const f = `gallery[${i}]`;
        if (!isObj(item)) return err('INVALID_FIELD', f, 'harus objek { path, caption? }');
        const pathIssue = checkPath(item.path, FOLDERS.gallery, `${f}.path`, imgExts);
        if (pathIssue) errors.push(pathIssue);
        else {
          claimPath(item.path as string, `${f}.path`);
          checkFile(item.path as string, `${f}.path`, LIMITS.maxImageBytes);
          backdropFiles.add(item.path as string);
        }
        const c = item.caption;
        if (c !== undefined && (typeof c !== 'string' || c.length > LIMITS.maxCaptionChars)) {
          err('INVALID_FIELD', `${f}.caption`, `teks maksimal ${LIMITS.maxCaptionChars} karakter`);
        }
      });
    }
  }

  // foto per lagu: boleh memakai foto galeri album; file dicek sekali
  for (const ref of trackPhotoRefs) {
    if (backdropFiles.has(ref.path)) continue;
    const owner = usedPaths.get(ref.path);
    if (owner) {
      err('INVALID_FIELD', ref.field, `path "${ref.path}" sudah dipakai di ${owner}`);
      continue;
    }
    backdropFiles.add(ref.path);
    checkFile(ref.path, ref.field, LIMITS.maxImageBytes);
  }
  if (backdropFiles.size > LIMITS.maxBackdropImages) {
    err('TOO_LARGE', 'gallery', `maksimal ${LIMITS.maxBackdropImages} foto latar berbeda (album + per lagu)`);
  }

  // --- metadata opsional ---
  if (raw.createdAt !== undefined && (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt)))) {
    warnings.push({ code: 'INVALID_FIELD', field: 'createdAt', message: 'bukan tanggal ISO 8601, diabaikan' });
  }

  // --- lisensi pembeli (opsional; hanya ada di salinan hasil unduhan) ---
  if (raw.license !== undefined) {
    const l = raw.license;
    if (!isObj(l)) err('INVALID_FIELD', 'license', 'harus objek');
    else {
      for (const key of ['orderId', 'licensee', 'issuedAt', 'issuer', 'signature'] as const) {
        if (typeof l[key] !== 'string' || l[key] === '') err('INVALID_FIELD', `license.${key}`, 'harus teks tidak kosong');
      }
      if (l.terms !== undefined && typeof l.terms !== 'string') err('INVALID_FIELD', 'license.terms', 'harus teks');
      if (typeof l.licensee === 'string' && !isMaskedLicensee(l.licensee)) {
        err('INVALID_FIELD', 'license.licensee', 'email pembeli harus disamarkan, mis. a***e@domain');
      }
    }
  }

  const ok = errors.length === 0;
  return { ok, manifest: ok ? (raw as unknown as RitmManifest) : undefined, errors, warnings };
}
