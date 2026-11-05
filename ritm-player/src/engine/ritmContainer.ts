import * as fflate from 'fflate';
import { unscrambleAudio } from '../format/scramble';
import type { ActiveMediaState, PlayableTrack, RitmAudioRef, RitmManifest, RitmManifestTrack, RitmTrackVisual } from '../types/ritm';
import { DEFAULT_THEME, INTEGRITY_PATH, LIMITS, MANIFEST_PATH, MIMETYPE_PATH, RITM_MIMETYPE } from '../format/constants';
import { checkIntegrity } from '../format/integrity';
import { bitrateBadge, detectAudioCodec, imageMimeFromPath, inferReleaseType, sniffAudioFormat } from '../format/detect';
import { RitmFormatError, type RitmIssue } from '../format/errors';
import { parseLRC } from '../format/lrc';
import { validateManifest } from '../format/validate';

export interface ParsedRitm {
  state: ActiveMediaState;
  manifest: RitmManifest;
  warnings: RitmIssue[];
}

export interface ParseOptions {
  /** Default URL.createObjectURL — bisa diganti untuk pengujian. */
  createUrl?: (blob: Blob) => string;
  /** Muat instrumental karaoke (hanya player desktop). Default false: web player tidak memuatnya. */
  includeKaraoke?: boolean;
}

/** Baca file .ritm dari input <input type="file"> / drag-drop. */
export async function parseRitmFile(file: Blob, opts?: ParseOptions): Promise<ParsedRitm> {
  return parseRitmBytes(new Uint8Array(await file.arrayBuffer()), opts);
}

export function parseRitmBytes(bytes: Uint8Array, opts: ParseOptions = {}): ParsedRitm {
  const createUrl = opts.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const warnings: RitmIssue[] = [];
  const fail = (issues: RitmIssue[]): never => {
    throw new RitmFormatError(issues);
  };

  // Tahap 1: indeks semua entry (ukuran asli) + ambil hanya mimetype & manifest.
  const sizes = new Map<string, number>();
  let head: fflate.Unzipped;
  try {
    head = fflate.unzipSync(bytes, {
      filter: (f) => {
        sizes.set(f.name, f.originalSize);
        return f.name === MANIFEST_PATH || f.name === MIMETYPE_PATH || f.name === INTEGRITY_PATH;
      },
    });
  } catch {
    return fail([{ code: 'NOT_ZIP', message: 'file bukan arsip .ritm yang valid' }]);
  }

  let total = 0;
  for (const s of sizes.values()) total += s;
  if (total > LIMITS.maxTotalBytes) {
    fail([{ code: 'TOO_LARGE', message: `isi arsip ${total} byte melebihi ${LIMITS.maxTotalBytes} byte` }]);
  }

  const mt = head[MIMETYPE_PATH];
  if (!mt) {
    warnings.push({ code: 'BAD_MIMETYPE', field: MIMETYPE_PATH, message: 'entry mimetype tidak ada' });
  } else if (fflate.strFromU8(mt).trim() !== RITM_MIMETYPE) {
    fail([{ code: 'BAD_MIMETYPE', field: MIMETYPE_PATH, message: `harus "${RITM_MIMETYPE}"` }]);
  }

  const manifestBytes = head[MANIFEST_PATH];
  if (!manifestBytes) return fail([{ code: 'NO_MANIFEST', message: 'manifest.json tidak ditemukan' }]);
  if (manifestBytes.length > LIMITS.maxManifestBytes) {
    fail([{ code: 'TOO_LARGE', field: MANIFEST_PATH, message: 'manifest.json terlalu besar' }]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fflate.strFromU8(manifestBytes));
  } catch {
    return fail([{ code: 'BAD_JSON', field: MANIFEST_PATH, message: 'manifest.json bukan JSON valid' }]);
  }

  const result = validateManifest(raw, { size: (p) => sizes.get(p) });
  warnings.push(...result.warnings);
  if (!result.ok || !result.manifest) return fail(result.errors);
  const manifest = result.manifest;

  // Tahap 2: ekstrak hanya file yang dirujuk manifest.
  const wanted = new Set<string>();
  for (const t of manifest.tracks) {
    wanted.add(t.audio.path);
    if (t.lyrics) wanted.add(t.lyrics.path);
    for (const ph of t.visual?.photos ?? []) wanted.add(ph.path);
    if (opts.includeKaraoke && t.karaoke) wanted.add(t.karaoke.path);
  }
  if (manifest.booklet?.cover) wanted.add(manifest.booklet.cover);
  if (manifest.booklet?.spread) wanted.add(manifest.booklet.spread);
  for (const p of manifest.booklet?.pages ?? []) wanted.add(p);
  for (const g of manifest.gallery ?? []) wanted.add(g.path);
  // Jika ada integrity.json, semua entry diekstrak untuk diperiksa hash-nya.
  const hasIntegrity = head[INTEGRITY_PATH] !== undefined;
  const files = fflate.unzipSync(bytes, { filter: (f) => hasIntegrity || wanted.has(f.name) });
  const integrity = checkIntegrity(files);

  // Cek isi audio sesuai codec yang dideklarasikan.
  const contentIssues: RitmIssue[] = [];
  manifest.tracks.forEach((t, i) => {
    const stored = files[t.audio.path];
    if (!stored) return;
    const data = unscrambleAudio(stored, t.audio);
    const detected = detectAudioCodec(data);
    if (detected === null) {
      warnings.push({ code: 'INVALID_FIELD', field: `tracks[${i}].audio`, message: 'codec tidak bisa diverifikasi dari isi file' });
    } else if (detected !== t.audio.codec) {
      contentIssues.push({
        code: 'INVALID_FIELD',
        field: `tracks[${i}].audio.codec`,
        message: `dideklarasikan ${t.audio.codec} tapi isi file terdeteksi ${detected}`,
      });
    }
  });
  manifest.tracks.forEach((t, i) => {
    if (!t.karaoke || !opts.includeKaraoke) return;
    const stored = files[t.karaoke.path];
    if (!stored) return;
    const detected = detectAudioCodec(unscrambleAudio(stored, t.karaoke));
    if (detected !== null && detected !== t.karaoke.codec) {
      contentIssues.push({
        code: 'INVALID_FIELD',
        field: `tracks[${i}].karaoke.codec`,
        message: `dideklarasikan ${t.karaoke.codec} tapi isi file terdeteksi ${detected}`,
      });
    }
  });
  if (contentIssues.length) fail(contentIssues);

  // Bangun state. Blob dibuat sekali per file (foto boleh dipakai bersama album & lagu).
  const urlCache = new Map<string, string>();
  const imageUrl = (path?: string) => {
    if (!path) return undefined;
    const hit = urlCache.get(path);
    if (hit) return hit;
    const data = files[path];
    if (!data) return undefined;
    const url = createUrl(new Blob([data], { type: imageMimeFromPath(path) ?? '' }));
    urlCache.set(path, url);
    return url;
  };
  const photoList = (list?: { path: string; caption?: string }[]) =>
    (list ?? []).flatMap((g) => {
      const url = imageUrl(g.path);
      return url ? [{ url, ...(g.caption ? { caption: g.caption } : {}) }] : [];
    });
  const visualOf = (v?: RitmTrackVisual): PlayableTrack['visual'] => {
    if (!v) return undefined;
    const photos = photoList(v.photos);
    if (!photos.length && !v.mood) return undefined;
    return { ...(photos.length ? { photos } : {}), ...(v.mood ? { mood: v.mood } : {}) };
  };

  const karaokeOf = (t: RitmManifestTrack): PlayableTrack['karaoke'] => {
    if (!opts.includeKaraoke || !t.karaoke) return undefined;
    const url = audioUrlAny(t.karaoke);
    return url ? { entry: t.karaoke.path, mime: t.karaoke.mime, url, ...(t.karaoke.scramble ? { scramble: t.karaoke.scramble } : {}) } : undefined;
  };
  const audioUrlAny = (ref: RitmAudioRef) => {
    const stored = files[ref.path];
    return stored ? createUrl(new Blob([unscrambleAudio(stored, ref)], { type: ref.mime })) : undefined;
  };

  const tracks: PlayableTrack[] = [...manifest.tracks]
    .sort((a, b) => a.trackNumber - b.trackNumber)
    .map((t) => {
      const audio = unscrambleAudio(files[t.audio.path]!, t.audio);
      const lrc = t.lyrics ? files[t.lyrics.path] : undefined;
      const lyrics = lrc ? parseLRC(fflate.strFromU8(lrc)) : undefined;
      return {
        trackNumber: t.trackNumber,
        title: t.title,
        artist: t.artist ?? manifest.artist,
        audioUrl: createUrl(new Blob([audio], { type: t.audio.mime })),
        entry: t.audio.path,
        ...(t.audio.scramble ? { scramble: t.audio.scramble } : {}),
        mime: t.audio.mime,
        bitrateBadge: bitrateBadge(t.audio.codec, t.audio.lossless, t.audio.bitrate),
        duration: t.duration,
        lyrics: lyrics && lyrics.length > 0 ? lyrics : undefined,
        visual: visualOf(t.visual),
        format: sniffAudioFormat(audio.subarray(0, 64 * 1024)) ?? undefined,
        karaoke: karaokeOf(t),
      };
    });

  const spreadUrl = imageUrl(manifest.booklet?.spread);
  const pageUrls = (manifest.booklet?.pages ?? []).map((p) => imageUrl(p)).filter((u): u is string => !!u);
  const editorialText = manifest.booklet?.editorialText;

  const state: ActiveMediaState = {
    sourceType: 'ritm',
    release: {
      title: manifest.title,
      artist: manifest.artist,
      catalogNumber: manifest.catalogNumber,
      year: manifest.year,
      type: manifest.releaseType ?? inferReleaseType(manifest.tracks.length),
    },
    tracks,
    theme: { ...DEFAULT_THEME, ...manifest.theme },
    artworkUrl: imageUrl(manifest.booklet?.cover),
    booklet: spreadUrl || pageUrls.length || editorialText ? { spreadUrl, pageUrls: pageUrls.length ? pageUrls : undefined, editorialText } : undefined,
    gallery: manifest.gallery?.length ? photoList(manifest.gallery) : undefined,
    integrity,
  };

  return { state, manifest, warnings };
}

/** Lepaskan semua Blob URL milik state. Panggil saat ganti rilisan. */
export function cleanupMediaState(state?: ActiveMediaState | null) {
  if (!state) return;
  for (const t of state.tracks) URL.revokeObjectURL(t.audioUrl);
  for (const t of state.tracks) if (t.karaoke) URL.revokeObjectURL(t.karaoke.url);
  if (state.artworkUrl) URL.revokeObjectURL(state.artworkUrl);
  if (state.booklet?.spreadUrl) URL.revokeObjectURL(state.booklet.spreadUrl);
  for (const u of state.booklet?.pageUrls ?? []) URL.revokeObjectURL(u);
  for (const g of state.gallery ?? []) URL.revokeObjectURL(g.url);
  for (const t of state.tracks) for (const ph of t.visual?.photos ?? []) URL.revokeObjectURL(ph.url);
}
