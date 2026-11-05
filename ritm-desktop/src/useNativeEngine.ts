import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveMediaState, AudioEngine, DspProfile, DspSettings, DspStats, EngineDsp } from '@ritm/player';
import type { NativeApi, NativeDevice, NativeEvent, NativeLoaded } from './desktop';
import type { MessageKey } from './i18n/locales/id';
import { nativeErrorKey } from './nativeErrors';

/** Backend keluaran Linux (diabaikan di Windows/macOS). */
export type LinuxAudioBackend = 'alsa' | 'pipewire';

/** Pengaturan keluaran mesin native (disimpan per perangkat komputer). */
export interface NativeSettings {
  mode: 'exclusive' | 'shared';
  /** ID perangkat; kosong = perangkat bawaan sistem. */
  device: string;
  buffer: 256 | 512 | 1024 | 2048 | 4096;
  phase: 'linear' | 'minimum';
  dither: boolean;
  shaping: boolean;
  /** Pilihan backend di Linux: ALSA (bit-perfect) atau PipeWire. */
  backend: LinuxAudioBackend;
}

export const DEFAULT_NATIVE: NativeSettings = {
  mode: 'exclusive',
  device: '',
  buffer: 1024,
  phase: 'linear',
  dither: true,
  shaping: true,
  backend: 'alsa',
};
const NATIVE_KEY = 'ritm-native';
const DSP_KEY = 'ritm-dsp';

function loadJson<T>(key: string, def: T, check: (v: Partial<T>) => T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<T> | null;
    return v ? check(v) : def;
  } catch {
    return def;
  }
}
const normalizeNative = (v: Partial<NativeSettings>): NativeSettings => ({
  mode: v.mode === 'shared' ? 'shared' : 'exclusive',
  device: typeof v.device === 'string' ? v.device : '',
  buffer: ([256, 512, 1024, 2048, 4096] as const).find((b) => b === v.buffer) ?? 1024,
  phase: v.phase === 'minimum' ? 'minimum' : 'linear',
  dither: v.dither !== false,
  shaping: v.shaping !== false,
  backend: v.backend === 'pipewire' ? 'pipewire' : 'alsa',
});
const loadNative = () => loadJson<NativeSettings>(NATIVE_KEY, DEFAULT_NATIVE, normalizeNative);
const loadDsp = () =>
  loadJson<DspSettings>(DSP_KEY, { profile: 'purist', guard: true }, (v) => ({ profile: v.profile === 'analog' ? 'analog' : 'purist', guard: v.guard !== false }));
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

/** Baca pengaturan native dari localStorage (untuk panel pengaturan). */
export function readNativeSettings(): NativeSettings {
  return loadNative();
}

/** Tulis patch ke localStorage tanpa hook React (fallback bila mesin native belum aktif). */
export function patchNativeSettings(patch: Partial<NativeSettings>): NativeSettings {
  const next = normalizeNative({ ...loadNative(), ...patch });
  save(NATIVE_KEY, next);
  return next;
}

/** Kontrol khusus mesin native (panel Sinyal). */
export interface NativeControls {
  settings: NativeSettings;
  update: (patch: Partial<NativeSettings>) => void;
  devices: NativeDevice[];
  refreshDevices: () => void;
  /** Info stream yang sedang terbuka: format keluaran, jalur bit-perfect/diproses & alasannya. */
  loaded: NativeLoaded | null;
  error: MessageKey | null;
}

export type NativeEngine = AudioEngine & { native: NativeControls };

const toDb = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);

/** Sumber satu track untuk perintah `open` dan `preload`. */
function sourceMsg(media: ActiveMediaState, track: ActiveMediaState['tracks'][number], filePath: string) {
  return {
    path: track.path ?? filePath,
    entry: media.sourceType === 'ritm' ? track.entry : undefined,
    scramble: media.sourceType === 'ritm' ? track.scramble : undefined,
  };
}

/**
 * Mesin audio native (sidecar ritm-audio). Antarmuka sama dengan `useAudioEngine` dari @ritm/player.
 * Audio dibaca langsung dari file di disk (entry .ritm tanpa disalin) — renderer hanya mengirim perintah.
 * `onFallback` dipanggil bila file/perangkat tidak bisa diputar native → pemanggil beralih ke Web Audio.
 */
export function useNativeEngine(
  media: ActiveMediaState | null,
  filePath: string | null,
  api: NativeApi | undefined,
  opts: { startIndex?: number; onFallback?: (index: number, reason: MessageKey) => void } = {},
): NativeEngine {
  const startIndex = Math.max(0, opts.startIndex ?? 0);
  const [pos, setPos] = useState<{ media: ActiveMediaState | null; index: number }>({ media, index: startIndex });
  const wantPlay = useRef(false);
  if (pos.media !== media) {
    setPos({ media, index: startIndex });
    wantPlay.current = !!media;
  }
  const index = pos.media === media ? pos.index : startIndex;
  const setIndex = useCallback(
    (u: number | ((i: number) => number)) => setPos((p) => ({ ...p, index: typeof u === 'function' ? u(p.index) : u })),
    [],
  );

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [loaded, setLoaded] = useState<NativeLoaded | null>(null);
  const [stats, setStats] = useState<DspStats | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [devices, setDevices] = useState<NativeDevice[]>([]);
  const [settings, setSettings] = useState<NativeSettings>(loadNative);
  const [dspSettings, setDspSettings] = useState<DspSettings>(loadDsp);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Pesan `open` terakhir, dikirim ulang bila perangkat yang disimpan tidak bisa dibuka. */
  const lastOpen = useRef<(Record<string, unknown> & { cmd: string }) | null>(null);
  /** Indeks track saat `open` terakhir; `advanced.n` dihitung dari sini. */
  const openBase = useRef(0);
  /** Indeks track yang ada di `lastOpen` (ikut berpindah saat gapless); dipakai pemulihan perangkat. */
  const lastOpenIndex = useRef(0);
  /** Perpindahan gapless sudah dicatat di state; effect buka track tidak membuka ulang aliran. */
  const skipOpen = useRef(false);

  const tracks = media?.tracks ?? [];
  const track = tracks[index] ?? null;
  const count = tracks.length;

  const last = useRef({ t: 0, at: 0, playing: false });
  const levels = useRef<number[]>([0, 0, 0, 0, 0, 0]);
  const awaiting = useRef(false); // abaikan pos/ended lagu sebelumnya sampai 'loaded' yang baru tiba
  const state = useRef({ index, count, duration, onFallback: opts.onFallback });
  state.current = { index, count, duration, onFallback: opts.onFallback };
  /** Pindah ke Web Audio bila tersedia. Rilisan folder tidak punya sumber Web Audio, jadi error ditampilkan saja. */
  const failTrack = (key: MessageKey) => {
    if (state.current.onFallback) state.current.onFallback(state.current.index, key);
    else setError(key);
  };

  const send = useCallback(
    (msg: Record<string, unknown> & { cmd: string }) => {
      if (!api) return;
      void api.send(msg).then((err) => {
        if (!err) return;
        console.warn('[native]', err);
        if (msg.cmd === 'open') failTrack(nativeErrorKey('PREPARE'));
        // preload hanya persiapan lagu berikutnya: gagal di sini tidak mengganggu lagu yang sedang diputar
        else if (msg.cmd !== 'preload') setError(nativeErrorKey());
      });
    },
    [api],
  );

  const now = () => performance.now();
  const currentTime = useCallback(() => {
    const l = last.current;
    const t = l.playing ? l.t + (now() - l.at) / 1000 : l.t;
    const d = state.current.duration;
    return d > 0 ? Math.min(t, d) : t;
  }, []);

  // ---- event dari mesin
  // siapkan lagu sesudah `i` di sisi mesin agar perpindahan gapless tidak berjeda
  const preloadAfter = useCallback(
    (i: number) => {
      if (!media || !filePath) return;
      const t = media.tracks[i + 1];
      if (t) send({ cmd: 'preload', ...sourceMsg(media, t, filePath) });
    },
    [media, filePath, send],
  );

  useEffect(() => {
    if (!api || !media) return;
    return api.onEvent((e: NativeEvent) => {
      switch (e.ev) {
        case 'devices':
          setDevices(e.list);
          break;
        case 'loaded': {
          awaiting.current = false;
          const { ev: _ev, ...info } = e;
          setLoaded(info as NativeLoaded);
          setError(null);
          if (e.duration > 0) setDuration(e.duration);
          last.current = { t: e.at, at: now(), playing: e.playing };
          setTime(e.at);
          setPlaying(e.playing);
          preloadAfter(state.current.index);
          break;
        }
        case 'advanced': {
          // lagu berikutnya sudah terdengar di aliran yang sama: cukup pindahkan state, jangan buka ulang perangkat
          if (awaiting.current) break; // peristiwa dari aliran sebelumnya yang sudah digantikan `open`
          const i = openBase.current + e.n;
          if (media && filePath && i < state.current.count && media.tracks[i]) {
            const t = media.tracks[i];
            skipOpen.current = true;
            lastOpenIndex.current = i;
            lastOpen.current = { cmd: 'open', ...sourceMsg(media, t, filePath), at: 0, play: true };
            setDuration(e.duration || t.duration || 0);
            setLoaded((l) => (l ? { ...l, duration: e.duration, source: { ...l.source, codec: e.codec } } : l));
            setIndex(i);
            preloadAfter(i);
          }
          break;
        }
        case 'pos': {
          if (awaiting.current) break;
          last.current = { t: e.t, at: now(), playing: e.playing };
          setPlaying(e.playing);
          if (!e.playing) setTime(e.t);
          levels.current = e.levels;
          setStats((s) => {
            const next: DspStats = {
              inputTpDb: toDb(e.tp.in),
              outputTpDb: toDb(e.tp.out),
              gainDb: typeof e.tp.gain === 'number' ? e.tp.gain : 0,
              overs: e.tp.overs ?? 0,
              profile: dspSettings.profile,
              guardActive: dspSettings.profile === 'analog' && dspSettings.guard,
            };
            return s && s.inputTpDb === next.inputTpDb && s.outputTpDb === next.outputTpDb && s.gainDb === next.gainDb && s.overs === next.overs && s.profile === next.profile
              ? s
              : next;
          });
          break;
        }
        case 'ended': {
          if (awaiting.current) break;
          levels.current = [0, 0, 0, 0, 0, 0];
          const { index: i, count: c } = state.current;
          if (i + 1 < c) {
            wantPlay.current = true;
            setIndex(i + 1);
          } else {
            wantPlay.current = false;
            setPlaying(false);
            last.current = { t: 0, at: now(), playing: false };
            setTime(0);
            send({ cmd: 'seek', t: 0 });
          }
          break;
        }
        case 'error':
          if (e.code === 'DEVICE' && settingsRef.current.device && lastOpen.current) {
            // perangkat yang disimpan tidak bisa dibuka (mis. DAC dicabut): pakai perangkat bawaan lalu ulangi, bukan pindah ke Web Audio
            const next = { ...settingsRef.current, device: '' };
            settingsRef.current = next;
            save(NATIVE_KEY, next);
            setSettings(next);
            send({ cmd: 'config', ...next, profile: dspSettings.profile, guard: dspSettings.guard });
            // buka ulang track yang sedang berjalan di posisi & status putar terakhir, bukan dari awal
            openBase.current = lastOpenIndex.current;
            const resume = { ...lastOpen.current, at: currentTime(), play: last.current.playing };
            lastOpen.current = resume;
            send(resume);
            break;
          }
          console.warn('[native]', e.code, e.message);
          if (awaiting.current || e.code === 'DECODE' || e.code === 'OPEN' || e.code === 'DEVICE') {
            awaiting.current = false;
            failTrack(nativeErrorKey(e.code));
          } else setError(nativeErrorKey(e.code));
          break;
        case 'crashed':
          console.warn('[native]', e.message);
          awaiting.current = false;
          setPlaying(false);
          failTrack(nativeErrorKey('CRASHED'));
          break;
        default:
          break;
      }
    });
    // dspSettings dibaca untuk label statistik saja
  }, [api, media, filePath, setIndex, send, dspSettings, currentTime, preloadAfter]);

  // ---- konfigurasi: dikirim saat mesin aktif & tiap kali berubah (mesin membuka ulang stream di posisi yang sama)
  // Pergantian lagu tidak memicunya: config yang datang sebelum `open` akan membuka ulang lagu lama (bunyi sekilas)
  // dan `loaded`-nya menghapus `awaiting`. Cukup dikirim saat media muncul (stream belum terbuka) dan saat pengaturan berubah.
  const hasMedia = !!media;
  useEffect(() => {
    if (!api || !hasMedia) return;
    send({ cmd: 'config', ...settings, profile: dspSettings.profile, guard: dspSettings.guard });
  }, [api, hasMedia, settings, dspSettings, send]);

  // ---- buka track
  useEffect(() => {
    if (!api) return;
    if (skipOpen.current) {
      skipOpen.current = false;
      return;
    }
    if (!media || !track || !filePath) {
      send({ cmd: 'stop' });
      setPlaying(false);
      setLoaded(null);
      return;
    }
    awaiting.current = true;
    openBase.current = index;
    lastOpenIndex.current = index;
    setStats(null);
    setTime(0);
    setDuration(track.duration ?? 0);
    last.current = { t: 0, at: now(), playing: false };
    const openMsg = {
      cmd: 'open',
      ...sourceMsg(media, track, filePath),
      at: 0,
      play: wantPlay.current,
    };
    lastOpen.current = openMsg;
    send(openMsg);
    // mesin bisa menyimpan status mute dari sesi hook sebelumnya: selalu sinkronkan dengan state UI
    send({ cmd: 'mute', on: muted });
    // `muted` sengaja tidak memicu buka ulang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, media, track, filePath, send]);

  // hentikan saat dilepas
  useEffect(() => () => void api?.send({ cmd: 'stop' }), [api]);

  // ---- waktu per frame (interpolasi antar event pos 50 ms)
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      setTime(currentTime());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, currentTime]);

  const play = useCallback(() => {
    if (!track) return;
    wantPlay.current = true;
    send({ cmd: 'play' });
    last.current = { ...last.current, at: now(), playing: true };
    setPlaying(true);
  }, [track, send]);

  const pause = useCallback(() => {
    wantPlay.current = false;
    const t = currentTime();
    send({ cmd: 'pause' });
    last.current = { t, at: now(), playing: false };
    setTime(t);
    setPlaying(false);
  }, [send, currentTime]);

  const toggle = useCallback(() => (last.current.playing ? pause() : play()), [play, pause]);

  const seek = useCallback(
    (t: number) => {
      const d = state.current.duration;
      const v = Math.max(0, d > 0 ? Math.min(t, d) : t);
      send({ cmd: 'seek', t: v });
      // seek di dekat batas lagu bisa membatalkan lagu berikutnya yang sudah disiapkan: siapkan ulang
      preloadAfter(state.current.index);
      last.current = { ...last.current, t: v, at: now() };
      setTime(v);
    },
    [send, preloadAfter],
  );

  const stop = useCallback(() => {
    pause();
    seek(0);
  }, [pause, seek]);

  const select = useCallback(
    (i: number) => {
      if (i < 0 || i >= count) return;
      wantPlay.current = true;
      setIndex(i);
    },
    [count, setIndex],
  );
  const next = useCallback(() => select(index + 1), [select, index]);
  const prev = useCallback(() => {
    if (currentTime() > 3) seek(0);
    else if (index > 0) select(index - 1);
    else seek(0);
  }, [currentTime, index, seek, select]);
  const seekBy = useCallback((d: number) => seek(currentTime() + d), [seek, currentTime]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      send({ cmd: 'mute', on: !m });
      return !m;
    });
  }, [send]);
  // volume digital sengaja tidak ada: jalur bit-perfect hanya utuh di 100% — atur volume di perangkat/amplifier
  const setVolume = useCallback(
    (v: number) => {
      const m = v <= 0;
      setMuted(m);
      send({ cmd: 'mute', on: m });
    },
    [send],
  );

  const readLevels = useCallback((out: number[]) => {
    const src = levels.current;
    const live = last.current.playing;
    for (let i = 0; i < out.length; i++) {
      const rms = live ? (src[Math.min(src.length - 1, Math.floor((i / out.length) * src.length))] ?? 0) : 0;
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      out[i] = Math.max(0, Math.min(1, (db + 48) / 44));
    }
  }, []);

  const refreshDevices = useCallback(() => send({ cmd: 'devices' }), [send]);
  useEffect(() => {
    if (api && media) refreshDevices();
  }, [api, media, refreshDevices]);

  const update = useCallback((patch: Partial<NativeSettings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      save(NATIVE_KEY, next);
      return next;
    });
  }, []);
  const updateDsp = useCallback((patch: Partial<DspSettings>) => {
    setDspSettings((cur) => {
      const next = { ...cur, ...patch };
      save(DSP_KEY, next);
      return next;
    });
  }, []);
  const setProfile = useCallback((p: DspProfile) => updateDsp({ profile: p }), [updateDsp]);
  const setGuard = useCallback((on: boolean) => updateDsp({ guard: on }), [updateDsp]);

  const dsp: EngineDsp = {
    ready: !!loaded,
    settings: dspSettings,
    setProfile,
    setGuard,
    stats,
    output: loaded ? { sampleRate: loaded.output.rate, baseLatencyMs: loaded.output.latencyMs, outputLatencyMs: 0 } : null,
  };

  return {
    dsp,
    native: { settings, update, devices, refreshDevices, loaded, error },
    track,
    trackIndex: index,
    trackCount: count,
    playing,
    time,
    duration,
    volume: muted ? 0 : 1,
    muted,
    play,
    pause,
    toggle,
    stop,
    seek,
    seekBy,
    next,
    prev,
    select,
    setVolume,
    toggleMute,
    readLevels,
  };
}
