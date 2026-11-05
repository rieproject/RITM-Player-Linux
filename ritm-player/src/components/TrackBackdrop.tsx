import { useEffect, useMemo, useState } from 'react';
import type { ActiveMediaState, PlayableTrack, RitmMood } from '../types/ritm';
import { FadeLayer, MoodCanvas, useCrossfade } from './MoodCanvas';
import type { BackdropPhoto } from './GalleryBackdrop';

export interface BackdropScene {
  /** Berubah → adegan lama memudar keluar, adegan baru memudar masuk. */
  key: string;
  photos: BackdropPhoto[];
  mood?: RitmMood;
}

/**
 * Pilih latar untuk lagu yang sedang diputar:
 * 1. foto khusus lagu (+ animasi mood sebagai lapisan di atasnya bila ada);
 * 2. hanya mood → animasi penuh;
 * 3. tanpa visual lagu → galeri album (perilaku lama).
 * Mengatur juga indeks foto & pergantian otomatis selama `active`.
 */
export function useTrackBackdrop(media: ActiveMediaState | null, track: PlayableTrack | null | undefined, active: boolean, intervalMs = 7000) {
  const own = track?.visual?.photos;
  const mood = track?.visual?.mood;
  const hasOwn = !!(own && own.length);
  const albumPhotos = media?.gallery;
  const scene = useMemo<BackdropScene>(() => {
    if (hasOwn || mood) return { key: `track-${track?.trackNumber}`, photos: own ?? [], mood };
    return { key: 'album', photos: albumPhotos ?? [] };
  }, [hasOwn, own, mood, albumPhotos, track?.trackNumber]);

  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [scene.key, media]);
  useEffect(() => {
    if (!active || scene.photos.length < 2) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % scene.photos.length), intervalMs);
    return () => clearTimeout(id);
  }, [active, scene.photos.length, index, intervalMs]);

  return { scene, index: Math.min(index, Math.max(0, scene.photos.length - 1)), setIndex };
}

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Latar layar lirik: foto (crossfade + Ken Burns) dan/atau animasi mood, berganti halus per lagu. */
export function TrackBackdrop({
  scene,
  index,
  visible,
  fallbackUrl,
  surface,
  readLevels,
  playing,
}: {
  scene: BackdropScene;
  index: number;
  visible: boolean;
  fallbackUrl?: string;
  surface: string;
  readLevels?: (out: number[]) => void;
  playing?: boolean;
}) {
  const layers = useCrossfade(scene.key, scene);
  const still = reduceMotion();
  return (
    <div
      aria-hidden="true"
      data-backdrop={scene.key}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ background: surface, opacity: visible ? 1 : 0, transition: 'opacity 900ms ease' }}
    >
      {layers.map(({ key, value: sc, leaving }) => {
        const hasPhotos = sc.photos.length > 0;
        const current = !leaving;
        return (
          <FadeLayer key={key} leaving={leaving}>
            {hasPhotos
              ? sc.photos.map((p, i) => {
                  const on = i === (current ? index : 0);
                  return (
                    <div key={p.url} className="absolute inset-0" style={{ opacity: on ? 1 : 0, transition: 'opacity 1400ms ease' }}>
                      <img
                        src={p.url}
                        alt=""
                        className="size-full object-cover"
                        style={{
                          transform: on && visible && !still ? 'scale(1.08)' : 'scale(1)',
                          transition: on ? 'transform 9s linear' : 'transform 0s linear 1.4s',
                        }}
                      />
                    </div>
                  );
                })
              : !sc.mood &&
                fallbackUrl && <img src={fallbackUrl} alt="" className="absolute inset-0 size-full scale-125 object-cover blur-3xl" style={{ opacity: 0.7 }} />}
            {/* scrim agar lirik selalu terbaca */}
            <div className={`absolute inset-0 ${hasPhotos || !sc.mood ? 'bg-black/45' : 'bg-black/20'}`} />
            {sc.mood && (
              <div className="absolute inset-0" style={hasPhotos ? { opacity: 0.6, mixBlendMode: 'screen' } : { opacity: 0.95 }}>
                <MoodCanvas mood={sc.mood} readLevels={readLevels} playing={playing} active={visible && current} />
              </div>
            )}
          </FadeLayer>
        );
      })}
    </div>
  );
}

/**
 * Animasi mood samar di belakang halaman rilisan selama lagu diputar (lirik mati).
 * Memudar keluar saat jeda / lagu tanpa mood / lirik aktif.
 */
export function AmbientMood({
  track,
  visible,
  readLevels,
  playing,
  className = 'fixed inset-0 -z-10',
}: {
  track: PlayableTrack | null | undefined;
  visible: boolean;
  readLevels?: (out: number[]) => void;
  playing?: boolean;
  className?: string;
}) {
  const mood = track?.visual?.mood;
  const show = visible && !!playing && !!mood;
  const key = mood ? `t${track?.trackNumber}-${mood.preset}-${mood.colors.join('')}` : 'none';
  const layers = useCrossfade(key, mood);
  return (
    <div
      aria-hidden="true"
      data-ambient-mood={mood ? mood.preset : ''}
      className={`pointer-events-none overflow-hidden ${className}`}
      style={{ opacity: show ? 1 : 0, transition: 'opacity 1200ms ease' }}
    >
      {layers.map(({ key: k, value: m, leaving }) =>
        m ? (
          <FadeLayer key={k} leaving={leaving}>
            <div className="size-full opacity-35 dark:opacity-30">
              <MoodCanvas mood={m} readLevels={readLevels} playing={playing} active={show && !leaving} />
            </div>
          </FadeLayer>
        ) : null,
      )}
    </div>
  );
}
