import type { RitmAudioCodec } from '../types/ritm';
import { AUDIO_CODECS, IMAGE_MIMES } from './constants';

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, start + len));

/** Deteksi codec audio dari magic bytes. Mengembalikan null bila tidak dikenali. */
export function detectAudioCodec(bytes: Uint8Array): RitmAudioCodec | null {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'aac';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame sync (11 bit set) — layer III
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** Deteksi tipe gambar dari magic bytes, mengembalikan ekstensi ("jpg" | "png" | "webp"). */
export function detectImageExt(bytes: Uint8Array): keyof typeof IMAGE_MIMES | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  return null;
}

export function codecFromMime(mime: string): RitmAudioCodec | null {
  const hit = (Object.keys(AUDIO_CODECS) as RitmAudioCodec[]).find((c) => AUDIO_CODECS[c].mime === mime);
  return hit ?? null;
}

export function imageMimeFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIMES[ext === 'jpeg' ? 'jpg' : ext];
}

/** Badge ringkas untuk UI: "LOSSLESS", "320K", atau nama codec. */
export function bitrateBadge(codec: RitmAudioCodec, lossless: boolean, bitrate?: number): string {
  if (lossless) return 'LOSSLESS';
  if (bitrate && bitrate > 0) return `${Math.round(bitrate)}K`;
  return codec.toUpperCase();
}

/** Tebak tipe rilisan dari jumlah lagu bila manifest tidak menyebutkan: 1–3 single, 4–6 EP, ≥ 7 album. */
export function inferReleaseType(trackCount: number): 'album' | 'ep' | 'single' {
  if (trackCount <= 3) return 'single';
  if (trackCount <= 6) return 'ep';
  return 'album';
}

export interface AudioFormatInfo {
  codec: RitmAudioCodec;
  sampleRate?: number;   // Hz
  bitDepth?: number;     // bit per sampel (hanya PCM/lossless)
  channels?: number;
}

const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Baca format teknis dari header file tanpa mendekode audio:
 * FLAC STREAMINFO, WAV fmt chunk, frame header MP3, header identifikasi Ogg Vorbis/Opus.
 * Nilai yang tidak bisa dibaca dibiarkan kosong.
 */
export function sniffAudioFormat(b: Uint8Array): AudioFormatInfo | null {
  const codec = detectAudioCodec(b);
  if (!codec) return null;
  const u32le = (o: number) => ((b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) >>> 0) + b[o + 3]! * 0x1000000;
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8);
  try {
    if (codec === 'flac' && b.length >= 42) {
      // fLaC + header blok (4) + STREAMINFO: byte 18..21 (relatif awal file) memuat rate(20) ch(3) bps(5)
      const o = 8 + 10;
      const rate = (b[o]! << 12) | (b[o + 1]! << 4) | (b[o + 2]! >> 4);
      const channels = ((b[o + 2]! >> 1) & 0x07) + 1;
      const bitDepth = (((b[o + 2]! & 0x01) << 4) | (b[o + 3]! >> 4)) + 1;
      return { codec, sampleRate: rate || undefined, bitDepth, channels };
    }
    if (codec === 'wav') {
      for (let o = 12; o + 8 <= b.length && o < 4096; ) {
        const id = ascii(b, o, 4);
        const size = u32le(o + 4);
        if (id === 'fmt ' && o + 24 <= b.length) {
          return { codec, channels: u16le(o + 10), sampleRate: u32le(o + 12), bitDepth: u16le(o + 22) };
        }
        o += 8 + size + (size & 1);
      }
      return { codec };
    }
    if (codec === 'mp3') {
      let o = 0;
      if (ascii(b, 0, 3) === 'ID3' && b.length > 10) o = 10 + ((b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!);
      for (const end = Math.min(b.length - 4, o + 8192); o < end; o++) {
        if (b[o] === 0xff && (b[o + 1]! & 0xe0) === 0xe0) {
          const ver = (b[o + 1]! >> 3) & 0x03;
          const ri = (b[o + 2]! >> 2) & 0x03;
          const rate = MP3_RATES[ver]?.[ri];
          if (rate) return { codec, sampleRate: rate, channels: ((b[o + 3]! >> 6) & 0x03) === 3 ? 1 : 2 };
        }
      }
      return { codec };
    }
    if (codec === 'ogg') {
      for (let o = 0; o < Math.min(b.length - 20, 512); o++) {
        if (b[o] === 0x01 && ascii(b, o + 1, 6) === 'vorbis') return { codec, channels: b[o + 11], sampleRate: u32le(o + 12) };
        if (ascii(b, o, 8) === 'OpusHead') return { codec, channels: b[o + 9], sampleRate: 48000 };
      }
      return { codec };
    }
  } catch {
    /* header terpotong */
  }
  return { codec };
}

/** Teks ringkas mis. "FLAC · 96 kHz · 24-bit · stereo". */
export function describeFormat(f?: AudioFormatInfo | null): string {
  if (!f) return '';
  const khz = f.sampleRate ? `${(f.sampleRate / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} kHz` : '';
  const bits = f.bitDepth ? `${f.bitDepth}-bit` : '';
  const ch = f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : f.channels ? `${f.channels} kanal` : '';
  return [f.codec.toUpperCase(), khz, bits, ch].filter(Boolean).join(' · ');
}
