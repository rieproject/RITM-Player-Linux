/** API dari preload Electron. Tidak ada saat dijalankan di browser biasa (mode uji / PWA). */
export interface RecentItem {
  path: string;
  title: string;
  artist: string;
  type: string;
  tracks: number;
  cover: string | null;
  accent: string | null;
  openedAt: string;
  missing?: boolean;
}

export interface OpenedFile {
  path: string;
  name: string;
  data: ArrayBuffer;
}

/** Hasil pilih folder: berkas audio di dalamnya dan cover folder (bila ada). */
export interface FolderPick {
  dir: string;
  name: string;
  files: { path: string; name: string }[];
  cover: string | null;
}

export interface HeadFile {
  name: string;
  size: number;
  data: ArrayBuffer;
}

export interface DesktopApi {
  openFolder(labels: { title: string }): Promise<FolderPick | null>;
  readHead(p: string): Promise<HeadFile>;
  platform: string;
  getWindowMode(): Promise<boolean>;
  onWindowModeChange(cb: (maximized: boolean) => void): () => void;
  openDialog(labels: { title: string; ritm: string; audio: string }): Promise<OpenedFile | null>;
  readPath(p: string): Promise<OpenedFile>;
  pathForFile(file: File): string | null;
  takePending(): Promise<string | null>;
  onOpenPath(cb: (p: string) => void): () => void;
  recent: {
    list(): Promise<RecentItem[]>;
    add(item: Omit<RecentItem, 'openedAt' | 'missing'>): Promise<boolean>;
    remove(p: string): Promise<boolean>;
  };
  showInFolder(p: string): Promise<void>;
  setTitle(t: string): void;
  fullScreen: {
    get(): Promise<boolean>;
    set(on: boolean): Promise<boolean>;
    onChange(cb: (on: boolean) => void): () => void;
  };
  findLyrics(q: { path: string | null; title: string; artist?: string; duration?: number; online: boolean }): Promise<{ lrc: string; source: 'sidecar' | 'online' } | null>;
  native?: NativeApi;
}

/** Event dari mesin native (lihat native/src/main.cpp & engine.cpp). */
export type NativeEvent =
  | { ev: 'ready'; version: string; backend: string }
  | { ev: 'devices'; list: NativeDevice[] }
  | { ev: 'config'; ok: boolean }
  | { ev: 'loaded' } & NativeLoaded
  | { ev: 'pos'; t: number; playing: boolean; levels: number[]; tp: { in: number | null; out: number | null; gain: number | null; overs: number } }
  | { ev: 'ended' }
  /** Lagu berikutnya sudah mulai terdengar tanpa jeda (gapless); `n` = jumlah perpindahan sejak `open`. */
  | { ev: 'advanced'; n: number; duration: number; codec: string }
  | { ev: 'stopped' }
  | { ev: 'error'; code: string; message: string }
  | { ev: 'crashed'; message: string };

export interface NativeDevice {
  id: string;
  name: string;
  default: boolean;
  mix: { rate: number; bits: number; float: boolean; channels: number };
}

export interface NativeLoaded {
  duration: number;
  at: number;
  playing: boolean;
  source: { codec: string; rate: number; bits: number; channels: number; float: boolean };
  output: { backend: string; mode: 'exclusive' | 'shared'; rate: number; bits: number; container: number; channels: number; float: boolean; latencyMs: number; bufferFrames: number };
  path: 'bitperfect' | 'processed';
  reasons: string[];
  dsp: { resampler: boolean; phase: string; dither: boolean; shaping: boolean; profile: string; guard: boolean };
}

export interface NativeApi {
  info(): Promise<{ available: boolean; running: boolean; version: string | null; backend: string | null }>;
  send(msg: Record<string, unknown> & { cmd: string }): Promise<string | null>;
  onEvent(cb: (e: NativeEvent) => void): () => void;
}

export const desktop: DesktopApi | undefined = (globalThis as { ritmDesktop?: DesktopApi }).ritmDesktop;

/** Thumbnail kecil (data URL JPEG) dari artwork, untuk perpustakaan. */
export async function thumbFrom(url?: string, size = 192): Promise<string | null> {
  if (!url) return null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
