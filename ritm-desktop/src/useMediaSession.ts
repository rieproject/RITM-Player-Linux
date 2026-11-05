import { useEffect } from 'react';
import type { ActiveMediaState, AudioEngine } from '@ritm/player';

/**
 * Hubungkan ke kontrol media sistem: tombol Play/Next/Prev di keyboard,
 * overlay media Windows, dan Now Playing macOS.
 */
export function useMediaSession(media: ActiveMediaState | null, engine: AudioEngine) {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  const t = engine.track;

  useEffect(() => {
    if (!ms) return;
    if (!media || !t) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: media.release.title,
      artwork: media.artworkUrl ? [{ src: media.artworkUrl, sizes: '512x512' }] : [],
    });
  }, [ms, media, t]);

  useEffect(() => {
    if (ms) ms.playbackState = engine.playing ? 'playing' : media ? 'paused' : 'none';
  }, [ms, engine.playing, media]);

  useEffect(() => {
    if (!ms) return;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h);
      } catch {}
    };
    set('play', () => engine.play());
    set('pause', () => engine.pause());
    set('stop', () => engine.stop());
    set('nexttrack', () => engine.next());
    set('previoustrack', () => engine.prev());
    set('seekto', (d) => d.seekTime !== undefined && engine.seek(d.seekTime));
    set('seekbackward', () => engine.seekBy(-10));
    set('seekforward', () => engine.seekBy(10));
    return () => {
      for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward'] as MediaSessionAction[]) set(a, null);
    };
  }, [ms, engine]);
}
