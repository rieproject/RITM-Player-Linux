import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveMediaState, PlayableTrack } from '../types/ritm';
import { DEFAULT_DSP, type DspProfile, type DspSettings, type DspStats } from '../audio/dsp/pipeline';
import type { DspNode } from '../audio/dsp/graph';

/** Kontrol DSP (hanya bila engine dibuat dengan `{ dsp: true }`). */
export interface EngineDsp {
  /** false = worklet belum/tidak bisa dimuat (audio tetap berjalan tanpa DSP). */
  ready: boolean;
  settings: DspSettings;
  setProfile: (p: DspProfile) => void;
  setGuard: (on: boolean) => void;
  stats: DspStats | null;
  /** Info jalur keluaran Web Audio. */
  output: { sampleRate: number; baseLatencyMs: number; outputLatencyMs: number } | null;
}

const DSP_KEY = 'ritm-dsp';
const loadDsp = (): DspSettings => {
  try {
    const v = JSON.parse(localStorage.getItem(DSP_KEY) ?? 'null') as Partial<DspSettings> | null;
    return {
      profile: v?.profile === 'analog' ? 'analog' : 'purist',
      guard: v?.guard !== false,
    };
  } catch {
    return { ...DEFAULT_DSP };
  }
};

export interface AudioEngine {
  track: PlayableTrack | null;
  trackIndex: number;
  trackCount: number;
  playing: boolean;
  time: number;      // detik, diperbarui per frame saat memutar
  duration: number;  // detik
  volume: number;    // 0..1
  muted: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  seek: (t: number) => void;
  seekBy: (d: number) => void;
  next: () => void;
  prev: () => void;
  select: (index: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  /** Isi `out` dengan level 0..1 per pita frekuensi (untuk LevelMeter). */
  readLevels: (out: number[]) => void;
  /** Bus DSP float32 (Purist / Analog Stage + Peak Guard); null bila tidak diaktifkan. */
  dsp: EngineDsp | null;
}

/**
 * Mesin audio tunggal untuk satu rilisan: satu <audio>, pindah track, auto-next,
 * waktu per frame, dan analyser Web Audio untuk level meter.
 */
export function useAudioEngine(media: ActiveMediaState | null, opts: { startIndex?: number; dsp?: boolean } = {}): AudioEngine {
  const dspEnabled = !!opts.dsp;
  const startIndex = Math.max(0, opts.startIndex ?? 0);
  const [audio] = useState(() => (typeof Audio !== 'undefined' ? new Audio() : null));
  const wantPlay = useRef(false);
  // indeks track disimpan bersama rilisannya, agar ganti rilisan langsung mulai dari track 1
  const [pos, setPos] = useState<{ media: ActiveMediaState | null; index: number }>({ media, index: startIndex });
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
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const graph = useRef<{ ctx: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null>(null);
  const dspNode = useRef<DspNode | null>(null);
  const [dspSettings, setDspSettings] = useState<DspSettings>(() => (dspEnabled ? loadDsp() : { ...DEFAULT_DSP }));
  const dspSettingsRef = useRef(dspSettings);
  dspSettingsRef.current = dspSettings;
  const [dspReady, setDspReady] = useState(false);
  const [dspStats, setDspStats] = useState<DspStats | null>(null);

  const tracks = media?.tracks ?? [];
  const track = tracks[index] ?? null;
  const count = tracks.length;

  const ensureGraph = useCallback(() => {
    if (!audio || graph.current || typeof AudioContext === 'undefined') return;
    try {
      // 'playback' → buffer lebih besar (stabil, non-blocking) — bukan untuk latensi rendah
      const ctx = new AudioContext({ latencyHint: dspEnabled ? 'playback' : 'interactive' });
      const src = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      graph.current = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
      if (dspEnabled && ctx.audioWorklet) {
        // bus DSP dimuat async; sampai siap, audio lewat jalur langsung
        void import('../audio/dsp/graph')
          .then(({ createDspNode }) => createDspNode(ctx, dspSettingsRef.current))
          .then((d) => {
            src.disconnect();
            src.connect(d.node);
            d.node.connect(analyser);
            d.onStats(setDspStats);
            dspNode.current = d;
            setDspReady(true);
          })
          .catch(() => setDspReady(false));
      }
    } catch {
      /* level meter opsional — audio tetap jalan */
    }
  }, [audio, dspEnabled]);

  // ganti sumber saat track berubah
  useEffect(() => {
    if (!audio) return;
    if (!track) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setTime(0);
      setDuration(0);
      return;
    }
    if (audio.src !== track.audioUrl) {
      audio.src = track.audioUrl;
      dspNode.current?.reset(); // atenuasi Peak Guard & statistik dihitung ulang per lagu
      setDspStats(null);
      setTime(0);
      setDuration(track.duration ?? 0);
    }
    if (wantPlay.current) audio.play().catch(() => setPlaying(false));
  }, [audio, track]);

  useEffect(() => {
    if (!audio) return;
    const onPlay = () => {
      setPlaying(true);
      // level meter: siapkan analyser untuk setiap awal putar (termasuk autoplay & auto-next)
      ensureGraph();
      graph.current?.ctx.resume().catch(() => {});
    };
    const onPause = () => setPlaying(false);
    const onMeta = () => Number.isFinite(audio.duration) && setDuration(audio.duration);
    const onSeeked = () => setTime(audio.currentTime);
    const onVol = () => {
      setVolumeState(audio.volume);
      setMuted(audio.muted);
    };
    const onEnded = () => {
      setIndex((i) => {
        if (i + 1 < count) {
          wantPlay.current = true;
          return i + 1;
        }
        wantPlay.current = false;
        audio.currentTime = 0;
        setTime(0);
        return i;
      });
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('volumechange', onVol);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('volumechange', onVol);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audio, count, setIndex, ensureGraph]);

  // waktu per frame
  useEffect(() => {
    if (!playing || !audio) return;
    let id = 0;
    const tick = () => {
      setTime(audio.currentTime);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, audio]);

  // hentikan saat komponen dilepas
  useEffect(() => () => {
    audio?.pause();
    graph.current?.ctx.close().catch(() => {});
  }, [audio]);


  const play = useCallback(() => {
    if (!audio || !track) return;
    wantPlay.current = true;
    ensureGraph();
    graph.current?.ctx.resume().catch(() => {});
    audio.play().catch(() => {});
  }, [audio, track, ensureGraph]);

  const pause = useCallback(() => {
    wantPlay.current = false;
    audio?.pause();
  }, [audio]);

  const toggle = useCallback(() => (audio && !audio.paused ? pause() : play()), [audio, play, pause]);

  const seek = useCallback(
    (t: number) => {
      if (!audio) return;
      const max = Number.isFinite(audio.duration) ? audio.duration : duration;
      audio.currentTime = Math.max(0, Math.min(t, max || t));
      setTime(audio.currentTime);
    },
    [audio, duration],
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
    if (audio && audio.currentTime > 3) seek(0);
    else if (index > 0) select(index - 1);
    else seek(0);
  }, [audio, index, seek, select]);

  const seekBy = useCallback((d: number) => seek((audio?.currentTime ?? 0) + d), [audio, seek]);

  const setVolume = useCallback(
    (v: number) => {
      if (!audio) return;
      audio.volume = Math.max(0, Math.min(1, v));
      if (audio.volume > 0) audio.muted = false;
    },
    [audio],
  );

  const toggleMute = useCallback(() => {
    if (audio) audio.muted = !audio.muted;
  }, [audio]);

  const readLevels = useCallback((out: number[]) => {
    const g = graph.current;
    if (!g) {
      out.fill(0);
      return;
    }
    g.analyser.getByteFrequencyData(g.data);
    // pita rendah–tengah paling "terlihat" bergerak
    const usable = Math.max(out.length, Math.floor(g.data.length * 0.7));
    const step = usable / out.length;
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      const from = Math.floor(i * step);
      const to = Math.max(from + 1, Math.floor((i + 1) * step));
      for (let j = from; j < to; j++) sum += g.data[j] ?? 0;
      out[i] = sum / (to - from) / 255;
    }
  }, []);

  const updateDsp = useCallback((patch: Partial<DspSettings>) => {
    setDspSettings((cur) => {
      const next = { ...cur, ...patch };
      dspNode.current?.setSettings(next);
      try {
        localStorage.setItem(DSP_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const setProfile = useCallback((p: DspProfile) => updateDsp({ profile: p }), [updateDsp]);
  const setGuard = useCallback((on: boolean) => updateDsp({ guard: on }), [updateDsp]);
  const ctxNow = graph.current?.ctx;
  const dsp: EngineDsp | null = dspEnabled
    ? {
        ready: dspReady,
        settings: dspSettings,
        setProfile,
        setGuard,
        stats: dspStats,
        output: ctxNow
          ? {
              sampleRate: ctxNow.sampleRate,
              baseLatencyMs: (ctxNow.baseLatency ?? 0) * 1000,
              outputLatencyMs: ((ctxNow as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000,
            }
          : null,
      }
    : null;

  return {
    dsp,
    track,
    trackIndex: index,
    trackCount: count,
    playing,
    time,
    duration,
    volume,
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
