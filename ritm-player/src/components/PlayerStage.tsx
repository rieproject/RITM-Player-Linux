import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Disc3 } from 'lucide-react';
import type { ActiveMediaState } from '../types/ritm';
import type { AudioEngine } from '../hooks/useAudioEngine';
import type { IslandState } from '../hooks/useIslandState';
import { usePlayerShortcuts } from '../hooks/usePlayerShortcuts';
import { DynamicIsland } from './DynamicIsland';
import { GalleryControls } from './GalleryBackdrop';
import { AmbientMood, TrackBackdrop, useTrackBackdrop } from './TrackBackdrop';
import { LyricsView } from './LyricsView';
import { RitmBrand } from './RitmLogo';
import { IntegrityBadge } from './IntegrityBadge';
import { usePlayerI18n } from '../i18n';

export interface PlayerStageProps {
  media: ActiveMediaState | null;
  engine: AudioEngine;
  island: IslandState;
  /** Header aplikasi; `immersive` = sedang di atas galeri gelap (pakai teks terang). Kosong → merek "RITM /PLAYER". */
  header?: (s: { immersive: boolean }) => ReactNode;
  /** Ditampilkan saat belum ada media. */
  empty?: ReactNode;
  /** Daftar trek khusus aplikasi desktop. */
  trackList?: ReactNode;
  onOpenBooklet?: () => void;
  photoIntervalMs?: number;
  /** Toggle karaoke (desktop). Tidak diisi = tombol tidak tampil. */
  karaoke?: { available: boolean; on: boolean; onToggle: () => void };
  /** Esc saat lirik tidak tampil (mis. untuk menutup pratinjau). Esc saat lirik tampil hanya menutup lirik. */
  onEscape?: () => void;
  /** Tampilkan romanisasi lirik di bawah baris asli (lihat LyricsView). */
  showRoman?: boolean;
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * Layar player Opsi A.
 * Lirik mati: cover besar + info rilisan di tengah, latar netral.
 * Lirik aktif: cover memudar & pindah ke Dynamic Island, latar menjadi galeri foto dari .ritm,
 * lirik tersinkron muncul di tengah.
 */
export function PlayerStage({ media, engine, island, header, empty, trackList, onOpenBooklet, photoIntervalMs = 7000, karaoke, onEscape, showRoman = true }: PlayerStageProps) {
  const { t } = usePlayerI18n();
  const [lyricsPref, setLyricsPref] = useState(false);
  const track = engine.track;
  const lyricsAvailable = !!track?.lyrics?.length;
  const lyricsOn = lyricsPref && lyricsAvailable;
  const accent = media?.theme.accentColor ?? '#f59e0b';
  const toggleLyrics = useCallback(() => {
    if (lyricsAvailable) setLyricsPref((v) => !v);
  }, [lyricsAvailable]);

  usePlayerShortcuts(engine, { enabled: !!media, onToggleLyrics: toggleLyrics });

  // Esc: tutup lirik bila tampil; bila tidak, serahkan ke onEscape (kecuali sedang di dalam dialog lain, mis. booklet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (lyricsOn) setLyricsPref(false);
      else onEscape?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lyricsOn, onEscape]);

  const { scene, index: photo, setIndex: setPhoto } = useTrackBackdrop(media, track, lyricsOn, photoIntervalMs);
  const photos = scene.photos;

  const meta = media
    ? [media.release.catalogNumber, media.release.year, `${media.tracks.length} track`].filter(Boolean).join(' · ')
    : '';

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AmbientMood track={track} visible={!lyricsOn} playing={engine.playing} readLevels={engine.readLevels} className="absolute inset-0" />
      <TrackBackdrop
        scene={scene}
        index={photo}
        visible={lyricsOn}
        fallbackUrl={media?.artworkUrl}
        surface={media?.theme.surfaceColor ?? '#0a0a0a'}
        readLevels={engine.readLevels}
        playing={engine.playing}
      />

      <div className="relative z-10" style={{ color: lyricsOn ? '#fff' : undefined, transition: 'color 600ms ease' }}>
        {header ? (
          header({ immersive: lyricsOn })
        ) : (
          <div className="flex h-14 items-center px-4 sm:px-6">
            <RitmBrand product="Player" />
          </div>
        )}
      </div>

      <main className="relative flex-1" style={{ minHeight: 'calc(100dvh - 76px)' }}>
        {!media ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 pb-24">{empty}</div>
        ) : (
          <>
            {/* cover + info rilisan */}
            <div
              className="absolute inset-x-0 top-2 flex flex-col items-center gap-7 px-6"
              inert={lyricsOn}
              aria-hidden={lyricsOn}
              style={{
                opacity: lyricsOn ? 0 : 1,
                transform: lyricsOn ? 'translateY(24px) scale(0.92)' : 'none',
                transition: `opacity 600ms ease, transform 700ms ${EASE}`,
              }}
            >
              <div
                className="aspect-square overflow-hidden rounded-[20px] bg-neutral-200 shadow-[0_24px_64px_rgba(0,0,0,0.18)] dark:bg-neutral-900"
                style={{ width: 'min(440px, 78vw, calc(100dvh - 430px))', minWidth: 160 }}
              >
                {media.artworkUrl ? (
                  <img src={media.artworkUrl} alt={`Cover ${media.release.title}`} className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center">
                    <Disc3 className="size-1/4 text-neutral-400" strokeWidth={1.25} aria-hidden />
                  </div>
                )}
              </div>
              <div className="flex max-w-xl flex-col items-center gap-1.5 text-center">
                <h1 className="text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl">{media.release.title}</h1>
                <p className="text-[17px] text-neutral-600 dark:text-neutral-400">{media.release.artist}</p>
                <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2.5">
                  {track && (
                    <span className="inline-flex h-[22px] items-center rounded-full bg-neutral-200/80 px-2.5 text-[10px] font-bold tracking-[0.06em] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                      {track.bitrateBadge}
                    </span>
                  )}
                  {media.integrity && <IntegrityBadge report={media.integrity} />}
                  {karaoke && (
                    <button
                      type="button"
                      onClick={karaoke.onToggle}
                      disabled={!karaoke.available}
                      aria-pressed={karaoke.on}
                      title={karaoke.available ? (karaoke.on ? t('karaoke.titleOn') : t('karaoke.titleOff')) : t('karaoke.titleNone')}
                      className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-[10px] font-bold tracking-[0.06em] transition-colors disabled:opacity-40 ${
                        karaoke.on ? 'text-black' : 'bg-neutral-200/80 text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
                      }`}
                      style={karaoke.on ? { background: accent } : undefined}
                    >
                      {t('karaoke.button')}
                    </button>
                  )}
                  <span className="text-[11px] font-medium tracking-[0.08em] text-neutral-500 uppercase tabular-nums">{meta}</span>
                </div>
              </div>
            </div>

            {/* lirik */}
            <div
              className="absolute inset-x-0 top-0 bottom-52"
              inert={!lyricsOn}
              aria-hidden={!lyricsOn}
              style={{
                opacity: lyricsOn ? 1 : 0,
                transform: lyricsOn ? 'none' : 'translateY(24px)',
                transition: `opacity 700ms ease 150ms, transform 800ms ${EASE} 150ms`,
              }}
            >
              {track?.lyrics && <LyricsView lines={track.lyrics} time={engine.time} onSeek={engine.seek} className="h-full" showRoman={showRoman} />}
            </div>
          </>
        )}
        {media && trackList && (
          <div
            className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-500"
            aria-hidden={lyricsOn}
            inert={lyricsOn}
            style={{ opacity: lyricsOn ? 0 : 1 }}
          >
            <div className="pointer-events-auto">{trackList}</div>
          </div>
        )}
      </main>

      <GalleryControls count={photos.length} index={photo} onIndex={setPhoto} visible={lyricsOn} caption={photos[photo]?.caption} />

      <DynamicIsland
        media={media}
        engine={engine}
        island={island}
        accent={accent}
        lyricsOn={lyricsOn}
        lyricsAvailable={lyricsAvailable}
        onToggleLyrics={toggleLyrics}
        bookletAvailable={!!media?.booklet}
        onOpenBooklet={() => onOpenBooklet?.()}
      />
    </div>
  );
}
