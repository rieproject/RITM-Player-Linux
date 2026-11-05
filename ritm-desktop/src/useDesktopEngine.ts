import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAudioEngine, type ActiveMediaState, type AudioEngine } from '@ritm/player';
import { desktop } from './desktop';
import type { MessageKey } from './i18n/locales/id';
import { useNativeEngine, type NativeControls } from './useNativeEngine';

export type EnginePref = 'native' | 'web';
const PREF_KEY = 'ritm-engine';

export interface EngineChoice {
  /** Mesin yang sedang memutar. */
  kind: 'native' | 'web';
  pref: EnginePref;
  setPref: (p: EnginePref) => void;
  /** null = belum diketahui; false = biner tidak ada (mis. build tanpa mesin native). */
  available: boolean | null;
  info: { version: string | null; backend: string | null } | null;
  /** Alasan rilisan ini diputar lewat Web Audio walau native dipilih. */
  fallbackReason: MessageKey | null;
  controls: NativeControls | null;
}

/**
 * Mesin audio desktop: native (WASAPI/CoreAudio, bit-perfect) bila tersedia & file punya path di disk,
 * selain itu Web Audio. Bila native gagal memutar sebuah rilisan (codec tak didukung OS, perangkat error,
 * mesin crash), rilisan itu otomatis dilanjutkan lewat Web Audio di track yang sama.
 */
/** Sumber putar pengganti: trek yang punya instrumental memakai karaoke; trek lain tetap vokal. */
function withKaraoke(media: ActiveMediaState): ActiveMediaState {
  return {
    ...media,
    tracks: media.tracks.map((t) => (t.karaoke ? { ...t, audioUrl: t.karaoke.url, entry: t.karaoke.entry, mime: t.karaoke.mime, scramble: t.karaoke.scramble } : t)),
  };
}

export function useDesktopEngine(
  media: ActiveMediaState | null,
  filePath: string | null,
  karaoke = false,
): { engine: AudioEngine; choice: EngineChoice } {
  const api = desktop?.native;
  const [info, setInfo] = useState<{ available: boolean; version: string | null; backend: string | null } | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.info().then(setInfo).catch(() => setInfo({ available: false, version: null, backend: null }));
    return api.onEvent((e) => {
      if (e.ev === 'ready') setInfo({ available: true, version: e.version, backend: e.backend });
    });
  }, [api]);

  const [pref, setPrefState] = useState<EnginePref>(() => {
    try {
      return localStorage.getItem(PREF_KEY) === 'web' ? 'web' : 'native';
    } catch {
      return 'native';
    }
  });
  const [fallback, setFallback] = useState<{ media: ActiveMediaState; index: number; time: number; reason: MessageKey } | null>(null);
  const handoff = useRef(0); // track yang sedang diputar saat berpindah mesin
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const indexRef = useRef(0); // track & posisi terakhir (diperbarui tiap render) untuk perpindahan sumber karaoke
  const trackRef = useRef<unknown>(null);
  const switchPending = useRef<{ from: unknown; time: number } | null>(null);
  const lastKaraoke = useRef(karaoke);
  const playMedia = useMemo(() => (media && karaoke ? withKaraoke(media) : media), [media, karaoke]);

  const fellBack = !!media && fallback?.media === media;
  // selagi info belum datang, anggap tersedia (hindari berpindah mesin di tengah lagu pertama)
  // rilisan folder hanya diputar native: tidak ada Blob audio untuk Web Audio
  const folder = !!media?.folderPath;
  const useNative = folder ? !!api && !!filePath : !!api && info?.available !== false && pref === 'native' && !!filePath && !fellBack;

  const timeRef = useRef(0);
  const onFallback = useCallback((index: number, reason: MessageKey) => {
    const m = mediaRef.current;
    if (m) setFallback({ media: m, index, time: timeRef.current, reason });
  }, []);

  // rilisan baru → mulai dari track 1 (handoff hanya untuk perpindahan mesin pada rilisan yang sama)
  const lastMedia = useRef(media);
  const mediaChanged = lastMedia.current !== media;
  if (mediaChanged) {
    lastMedia.current = media;
    handoff.current = 0;
  }
  // toggle karaoke pada rilisan yang sama: mulai ulang di track & posisi yang sama
  if (lastKaraoke.current !== karaoke) {
    lastKaraoke.current = karaoke;
    if (!mediaChanged) {
      handoff.current = indexRef.current;
      switchPending.current = { from: trackRef.current, time: timeRef.current };
    }
  }

  const startIndex = fellBack ? fallback!.index : handoff.current;
  const web = useAudioEngine(useNative ? null : playMedia, { dsp: true, startIndex });
  const nat = useNativeEngine(useNative ? playMedia : null, filePath, api, { startIndex, onFallback: folder ? undefined : onFallback });
  const engine = useNative ? nat : web;
  timeRef.current = engine.time;
  indexRef.current = engine.trackIndex;
  trackRef.current = engine.track;

  // setelah sumber karaoke berganti, lanjutkan dari posisi yang sama
  useEffect(() => {
    const p = switchPending.current;
    if (!p || !engine.track || engine.track === p.from) return;
    switchPending.current = null;
    if (p.time > 0.5) engine.seek(p.time);
  }, [engine.track]);

  // lanjutkan dari posisi terakhir setelah berpindah ke Web Audio (sekali per fallback)
  const resumed = useRef<object | null>(null);
  useEffect(() => {
    if (!fellBack || !fallback || resumed.current === fallback || web.trackIndex !== fallback.index || !web.track) return;
    resumed.current = fallback;
    if (fallback.time > 0.5) web.seek(fallback.time);
  }, [fellBack, fallback, web]);

  const setPref = useCallback(
    (p: EnginePref) => {
      handoff.current = engine.trackIndex;
      setFallback(null);
      setPrefState(p);
      try {
        localStorage.setItem(PREF_KEY, p);
      } catch {}
    },
    [engine.trackIndex],
  );

  return {
    engine,
    choice: {
      kind: useNative ? 'native' : 'web',
      pref,
      setPref,
      available: api ? (info ? info.available : null) : false,
      info: info ? { version: info.version, backend: info.backend } : null,
      fallbackReason: fellBack ? fallback!.reason : null,
      // tetap sediakan kontrol pengaturan walau lagu sedang diputar lewat Web Audio
      controls: api ? nat.native : null,
    },
  };
}
