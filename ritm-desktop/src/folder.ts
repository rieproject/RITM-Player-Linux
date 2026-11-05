import {
  AUDIO_CODECS,
  DEFAULT_THEME,
  bitrateBadge,
  parseLRC,
  probeAudio,
  type ActiveMediaState,
  type AudioProbe,
  type LyricLine,
  type PlayableTrack,
} from '@ritm/player';
import { desktop, type FolderPick } from './desktop';
import { attachLyrics } from './lyrics';

const baseName = (name: string) => name.replace(/\.[^/.]+$/, '');
const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const AUDIO_FILE = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png'];

/**
 * Playlist dari folder audio biasa (desktop).
 * Metadata dibaca per file dari bagian awal berkas. File tanpa tag tetap tampil dengan nama filenya.
 * Tidak ada booklet, galeri, visual, karaoke, atau status integritas: semua itu tetap eksklusif milik .ritm.
 */
export async function buildFolderMedia(pick: FolderPick): Promise<ActiveMediaState> {
  const d = desktop;
  if (!d) throw new Error('folder hanya tersedia di aplikasi desktop');

  const probed: { path: string; name: string; probe: AudioProbe | null }[] = await Promise.all(
    pick.files.map(async (f) => {
      try {
        const head = await d.readHead(f.path);
        return { ...f, probe: await probeAudio(new File([head.data], f.name)) };
      } catch {
        return { ...f, probe: null };
      }
    }),
  );

  probed.sort(
    (a, b) =>
      (a.probe?.trackNumber ?? 999) - (b.probe?.trackNumber ?? 999) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );

  const built: PlayableTrack[] = probed.map((f, i) => {
    const p = f.probe;
    const codec = p?.codec ?? null;
    return {
      trackNumber: i + 1,
      title: p?.title ?? baseName(f.name),
      artist: p?.artist ?? p?.albumArtist ?? '',
      audioUrl: '',
      path: f.path,
      mime: codec ? AUDIO_CODECS[codec].mime : 'audio/*',
      bitrateBadge: codec && p ? bitrateBadge(codec, p.lossless, p.bitrate) : 'AUDIO',
      duration: p?.duration,
    };
  });

  // lirik per file (sidecar .lrc, lalu pencarian daring bila diaktifkan), sama seperti file audio biasa
  const tracks = await Promise.all(
    built.map(async (tr) => {
      const single: ActiveMediaState = {
        sourceType: 'standard',
        release: { title: tr.title, artist: tr.artist },
        tracks: [tr],
        theme: DEFAULT_THEME,
      };
      const got = await attachLyrics(single, tr.path ?? null);
      return got.tracks[0] ?? tr;
    }),
  );

  // cover: file cover/folder di folder itu, atau gambar tag pertama yang ada
  let artworkUrl: string | undefined;
  if (pick.cover) {
    const head = await d.readHead(pick.cover);
    artworkUrl = URL.createObjectURL(new Blob([head.data], { type: IMAGE_MIME[extOf(pick.cover)] ?? 'image/jpeg' }));
  } else {
    const pic = probed.find((f) => f.probe?.picture)?.probe?.picture;
    if (pic) artworkUrl = URL.createObjectURL(new Blob([pic.data as Uint8Array<ArrayBuffer>], { type: pic.mime }));
  }

  return {
    sourceType: 'standard',
    folderPath: pick.dir,
    release: { title: pick.name, artist: '' },
    tracks,
    theme: { ...DEFAULT_THEME },
    artworkUrl,
  };
}

/**
 * Playlist dari folder yang dipilih di browser (web / PWA).
 * Hanya berkas di folder yang dipilih (tidak rekursif). Lirik .lrc dengan nama yang sama ikut dibaca.
 * Pencarian lirik daring tidak dipakai di web. File tetap di perangkat; audio diputar lewat Web Audio.
 */
export async function buildWebFolderMedia(all: File[]): Promise<ActiveMediaState> {
  const parts = (f: File) => f.webkitRelativePath.split('/').filter(Boolean);
  // folder: segmen pertama dari jalur relatif; bila dipilih sebagai berkas biasa (tanpa jalur), pakai nama "Playlist"
  const folderName = all.length && parts(all[0]!).length > 1 ? parts(all[0]!)[0]! : 'Playlist';
  // hanya berkas langsung di folder itu (satu tingkat), sama seperti di desktop
  const direct = all.filter((f) => parts(f).length <= 2);
  const audio = direct.filter((f) => AUDIO_FILE.test(f.name));
  const lrcs = new Map<string, File>();
  for (const f of direct) if (/\.lrc$/i.test(f.name)) lrcs.set(baseName(f.name).toLowerCase(), f);
  const coverFile = direct.find((f) => COVER_NAMES.includes(f.name.toLowerCase())) ?? null;

  const probed = await Promise.all(
    audio.map(async (f) => ({ f, probe: await probeAudio(f).catch(() => null) })),
  );
  probed.sort(
    (a, b) =>
      (a.probe?.trackNumber ?? 999) - (b.probe?.trackNumber ?? 999) ||
      a.f.name.localeCompare(b.f.name, undefined, { numeric: true }),
  );

  const tracks: PlayableTrack[] = await Promise.all(
    probed.map(async ({ f, probe: p }, i) => {
      const codec = p?.codec ?? null;
      let lyrics: LyricLine[] | undefined;
      const lrc = lrcs.get(baseName(f.name).toLowerCase());
      if (lrc) {
        const parsed = parseLRC(await lrc.text());
        if (parsed.length > 0) lyrics = parsed;
      }
      return {
        trackNumber: i + 1,
        title: p?.title ?? baseName(f.name),
        artist: p?.artist ?? p?.albumArtist ?? '',
        audioUrl: URL.createObjectURL(f),
        mime: codec ? AUDIO_CODECS[codec].mime : f.type || 'audio/*',
        bitrateBadge: codec && p ? bitrateBadge(codec, p.lossless, p.bitrate) : 'AUDIO',
        duration: p?.duration,
        ...(lyrics ? { lyrics } : {}),
      };
    }),
  );

  // lirik daring untuk track yang belum punya .lrc (sama seperti file audio biasa, bila diaktifkan)
  const withOnline = await Promise.all(
    tracks.map(async (tr) => {
      const got = await attachLyrics({ sourceType: 'standard', release: { title: tr.title, artist: tr.artist }, tracks: [tr], theme: DEFAULT_THEME }, null);
      return got.tracks[0] ?? tr;
    }),
  );

  let artworkUrl: string | undefined;
  if (coverFile) {
    artworkUrl = URL.createObjectURL(coverFile);
  } else {
    const pic = probed.find((x) => x.probe?.picture)?.probe?.picture;
    if (pic) artworkUrl = URL.createObjectURL(new Blob([pic.data as Uint8Array<ArrayBuffer>], { type: pic.mime }));
  }

  return {
    sourceType: 'standard',
    folderPath: folderName,
    release: { title: folderName, artist: '' },
    tracks: withOnline,
    theme: { ...DEFAULT_THEME },
    artworkUrl,
  };
}
