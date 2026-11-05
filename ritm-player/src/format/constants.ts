import type { RitmAudioCodec, RitmTheme } from '../types/ritm';

export const RITM_MIMETYPE = 'application/vnd.ritm+zip';
export const RITM_FORMAT_VERSION = 1 as const;
export const MANIFEST_PATH = 'manifest.json';
export const MIMETYPE_PATH = 'mimetype';
/** Daftar hash SHA-256 per entry (dibuat archiver). Tidak menghash dirinya sendiri. */
export const INTEGRITY_PATH = 'integrity.json';

export const DEFAULT_THEME: RitmTheme = {
  surfaceColor: '#0a0a0a',
  surfaceOpacity: 1,
  textColor: '#f5f5f5',
  accentColor: '#f59e0b',
};

export const LIMITS = {
  maxTracks: 99,
  maxTotalBytes: 500 * 1024 * 1024,   // 500 MB isi setelah dekompresi
  maxTrackBytes: 200 * 1024 * 1024,   // 200 MB per audio
  maxImageBytes: 10 * 1024 * 1024,    // 10 MB per gambar
  maxGalleryImages: 30,
  maxBookletPages: 5,                 // halaman booklet (field booklet.pages)
  maxTrackPhotos: 10,                 // foto latar per lagu
  maxBackdropImages: 60,              // total file berbeda di gallery/ (album + per lagu)
  maxMoodColors: 3,
  maxCaptionChars: 200,
  maxLyricsBytes: 512 * 1024,         // 512 KB per .lrc
  maxManifestBytes: 256 * 1024,       // 256 KB
  maxEditorialChars: 20_000,
  maxTextChars: 200,                  // judul, artis, katalog
} as const;

export const AUDIO_CODECS: Record<RitmAudioCodec, { mime: string; ext: string; lossless: boolean }> = {
  flac: { mime: 'audio/flac', ext: 'flac', lossless: true },
  wav: { mime: 'audio/wav', ext: 'wav', lossless: true },
  mp3: { mime: 'audio/mpeg', ext: 'mp3', lossless: false },
  ogg: { mime: 'audio/ogg', ext: 'ogg', lossless: false },
  aac: { mime: 'audio/mp4', ext: 'm4a', lossless: false },
};

export const IMAGE_MIMES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export const MOOD_PRESETS = ['aurora', 'waves', 'particles', 'rain', 'fog'] as const;

// Folder yang diizinkan untuk setiap jenis aset
export const FOLDERS = {
  audio: 'audio/',
  lyrics: 'lyrics/',
  booklet: 'booklet/',
  gallery: 'gallery/',
  karaoke: 'karaoke/',
} as const;
