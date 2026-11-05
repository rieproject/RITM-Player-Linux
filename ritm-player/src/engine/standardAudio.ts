import { parseBlob } from 'music-metadata';
import type { ActiveMediaState, RitmAudioCodec } from '../types/ritm';
import { AUDIO_CODECS, DEFAULT_THEME } from '../format/constants';
import { bitrateBadge, detectAudioCodec, sniffAudioFormat } from '../format/detect';

export interface AudioProbe {
  codec: RitmAudioCodec | null; // null = tidak dikenali
  lossless: boolean;
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  trackNumber?: number;
  duration?: number;            // detik
  bitrate?: number;             // kbps
  picture?: { data: Uint8Array; mime: string };
}

const CONTAINER_TO_CODEC: Record<string, RitmAudioCodec> = {
  flac: 'flac',
  wave: 'wav',
  'mpeg': 'mp3',
  ogg: 'ogg',
  'm4a/aac': 'aac',
  mp4: 'aac',
  m4a: 'aac',
};

/**
 * Baca tag & info teknis audio. Codec ditentukan dari magic bytes (sama dengan aturan format .ritm),
 * metadata lain dari music-metadata. Tidak melempar error bila tag rusak — field dibiarkan kosong.
 */
export async function probeAudio(file: Blob): Promise<AudioProbe> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let codec = detectAudioCodec(head);

  try {
    const meta = await parseBlob(file, { duration: false, skipCovers: false });
    const container = (meta.format.container ?? '').toLowerCase();
    codec ??= CONTAINER_TO_CODEC[container] ?? null;
    const pic = meta.common.picture?.[0];
    const lossless = codec ? AUDIO_CODECS[codec].lossless : !!meta.format.lossless;
    return {
      codec,
      lossless,
      title: meta.common.title?.trim() || undefined,
      artist: meta.common.artist?.trim() || undefined,
      albumArtist: meta.common.albumartist?.trim() || undefined,
      album: meta.common.album?.trim() || undefined,
      year: meta.common.year,
      trackNumber: meta.common.track.no ?? undefined,
      duration: meta.format.duration && meta.format.duration > 0 ? meta.format.duration : undefined,
      bitrate: !lossless && meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : undefined,
      picture: pic ? { data: pic.data, mime: pic.format } : undefined,
    };
  } catch {
    return { codec, lossless: codec ? AUDIO_CODECS[codec].lossless : false };
  }
}

const baseName = (name: string) => name.replace(/\.[^/.]+$/, '');

/** Audio standar → ActiveMediaState dengan satu track dan tema default. */
export async function parseStandardAudio(
  file: File,
  opts: { createUrl?: (b: Blob) => string } = {},
): Promise<ActiveMediaState> {
  const createUrl = opts.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const p = await probeAudio(file);
  const title = p.title ?? baseName(file.name);
  const artist = p.artist ?? 'UNKNOWN ARTIST';
  const mime = p.codec ? AUDIO_CODECS[p.codec].mime : file.type || 'audio/*';

  return {
    sourceType: 'standard',
    release: { title: p.album ?? title, artist, year: p.year },
    tracks: [
      {
        trackNumber: 1,
        title,
        artist,
        audioUrl: createUrl(file.type === mime ? file : new Blob([file], { type: mime })),
        mime,
        bitrateBadge: p.codec ? bitrateBadge(p.codec, p.lossless, p.bitrate) : 'AUDIO',
        duration: p.duration,
        format: sniffAudioFormat(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())) ?? undefined,
      },
    ],
    theme: { ...DEFAULT_THEME },
    artworkUrl: p.picture
      ? createUrl(new Blob([p.picture.data as Uint8Array<ArrayBuffer>], { type: p.picture.mime }))
      : undefined,
  };
}
