// Kontrak tipe data bersama RITM Ecosystem.
// Format .ritm v1 — lihat spesifikasi bagian "Format .ritm v1".

export interface LyricLine {
  time: number; // detik
  text: string;
  /** Romanisasi baris (mis. romaji untuk Jepang). Hanya transliterasi; tampil di bawah baris asli bila diaktifkan. */
  roman?: string;
}

export interface RitmTheme {
  surfaceColor: string;   // #rrggbb, default #0a0a0a
  surfaceOpacity: number; // 0.2 - 1.0, default 1
  textColor: string;      // #rrggbb, default #f5f5f5
  accentColor: string;    // #rrggbb, default #f59e0b
}

export type RitmReleaseType = 'album' | 'ep' | 'single';

export type RitmAudioCodec = 'flac' | 'wav' | 'mp3' | 'ogg' | 'aac';

/** Preset animasi latar yang digambar player (tanpa file), bereaksi terhadap musik. */
export type RitmMoodPreset = 'aurora' | 'waves' | 'particles' | 'rain' | 'fog';

export interface RitmMood {
  preset: RitmMoodPreset;
  colors: string[];             // 1–3 warna #rrggbb
  energy?: number;              // 0–1, default 0.5 (tenang → bersemangat)
}

/** Visual latar per lagu (tampil saat lirik aktif). Kosong → galeri album. */
export interface RitmTrackVisual<P = { path: string; caption?: string }> {
  photos?: P[];                 // foto khusus lagu ini, file di gallery/ (boleh dipakai bersama galeri album)
  mood?: RitmMood;              // animasi; bila ada foto, tampil sebagai lapisan di atas foto
}

/** Referensi file audio (utama atau karaoke). */
export interface RitmAudioRef {
  path: string;               // mis. "audio/01.flac" atau "karaoke/01.flac"
  mime: string;
  codec: RitmAudioCodec;
  lossless: boolean;
  bitrate?: number;           // kbps, untuk codec lossy
  /** Pengacakan isi entry di arsip (lihat format/scramble.ts). Tanpa field ini = tidak diacak. */
  scramble?: 'xor-v1';
}

export interface RitmManifestTrack {
  trackNumber: number;          // 1..99, unik
  title: string;
  artist?: string;              // default: artist rilisan
  duration?: number;            // detik, hanya petunjuk
  audio: RitmAudioRef;
  /** Instrumental untuk karaoke (desktop saja). Ada = toggle karaoke aktif untuk track ini. */
  karaoke?: RitmAudioRef;
  lyrics?: { path: string };    // mis. "lyrics/01.lrc"
  visual?: RitmTrackVisual;
}

export interface RitmManifest {
  format: 'ritm';
  formatVersion: 1;
  title: string;
  artist: string;
  catalogNumber?: string;
  year?: number;
  releaseType?: RitmReleaseType; // kosong → ditebak dari jumlah lagu (inferReleaseType)
  releaseDate?: string;          // YYYY-MM-DD
  genre?: string;
  label?: string;
  theme?: Partial<RitmTheme>;
  tracks: RitmManifestTrack[];
  booklet?: {
    cover?: string;             // mis. "booklet/cover.jpg"
    spread?: string;            // mis. "booklet/spread.jpg" (rilisan lama, satu gambar)
    pages?: string[];           // halaman booklet, maks 5, urutan = urutan buka: ["booklet/p01.jpg", ...]
    thumb?: string;             // thumbnail persegi 512 px untuk storefront, mis. "booklet/thumb.jpg"
    editorialText?: string;
  };
  gallery?: {                   // foto latar saat lirik aktif, urutan = urutan tampil
    path: string;               // mis. "gallery/01.jpg"
    caption?: string;
  }[];
  createdAt?: string;           // ISO 8601
  generator?: string;           // mis. "ritm-archiver/2.3.0"
  /** Lisensi pribadi pembeli. Hanya ada di salinan yang diunduh pembeli (dibuat server), tidak pernah di master. */
  license?: RitmLicense;
}

/** Lisensi personal: penanda pemilik salinan, bukan pengalihan hak cipta dan bukan pengikat teknis (tanpa DRM). */
export interface RitmLicense {
  orderId: string;
  licensee: string;             // email yang sudah disamarkan, mis. "a***e@gmail.com"
  issuedAt: string;             // ISO 8601
  issuer: string;               // mis. "RITM"
  terms?: string;               // kode versi syarat lisensi, mis. "personal-v1"
  signature: string;            // "ed25519:<keyId>:<base64>", lihat format/license.ts
}

// ---- State yang dipakai UI player ----

export interface PlayableTrack {
  trackNumber: number;
  title: string;
  artist: string;
  audioUrl: string;             // Blob URL
  /** Path berkas di disk (playlist folder, desktop). Bila ada, mesin native membuka berkas ini langsung. */
  path?: string;
  /** Path audio di dalam arsip .ritm (entry ZIP stored) — dipakai mesin native untuk membaca langsung dari file. */
  entry?: string;
  /** Entry di arsip diacak (xor-v1); native engine dan pembaca lain harus membaliknya. */
  scramble?: 'xor-v1';
  mime: string;
  bitrateBadge: string;         // "LOSSLESS", "320K", "MP3"
  duration?: number;
  lyrics?: LyricLine[];
  visual?: RitmTrackVisual<{ url: string; caption?: string }>;
  /** Instrumental karaoke (hanya bila parser diminta memuatnya, mis. desktop). */
  karaoke?: { entry: string; mime: string; url: string; scramble?: 'xor-v1' };
  /** Format teknis sumber, dibaca dari header file (untuk info sinyal). */
  format?: { codec: RitmAudioCodec; sampleRate?: number; bitDepth?: number; channels?: number };
}

/** Hasil pemeriksaan integritas arsip. 'verified' dipakai setelah tanda tangan diperiksa (tahap 5). */
export type IntegrityStatus = 'unsigned' | 'tampered' | 'verified';

export interface IntegrityReport {
  status: IntegrityStatus;
  hasIntegrity: boolean;      // false = rilisan lama tanpa integrity.json
  mismatched: string[];       // entry yang hash-nya tidak cocok / hilang / tambahan
  keyId?: string;             // kunci penandatangan (bila ada signature.json)
}

export interface ActiveMediaState {
  sourceType: 'ritm' | 'standard';
  /** Folder asal playlist audio biasa (desktop). Tidak ada fitur eksklusif .ritm pada rilisan ini. */
  folderPath?: string;
  release: {
    title: string;
    artist: string;
    catalogNumber?: string;
    year?: number;
    type?: RitmReleaseType;
  };
  tracks: PlayableTrack[];      // minimal 1, urut trackNumber
  theme: RitmTheme;
  artworkUrl?: string;          // cover booklet atau cover ID3
  booklet?: {
    spreadUrl?: string;         // rilisan lama: satu gambar
    pageUrls?: string[];        // halaman booklet, urutan buka (maks 5)
    editorialText?: string;
  };
  gallery?: { url: string; caption?: string }[];
  integrity?: IntegrityReport;
}

// Mode tampilan Dynamic Island
export type IslandMode = 'hidden' | 'compact' | 'expanded' | 'alert';

export interface IslandAlert {
  kind: 'loaded' | 'error' | 'info';
  text: string;                 // ringkas, mis. "LOADED", "FORMAT ERROR"
  durationMs?: number;
}
