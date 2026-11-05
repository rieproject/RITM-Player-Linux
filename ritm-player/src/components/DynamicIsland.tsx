import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, BookOpen, Check, Disc3, Info, MicVocal, Pause, Play, SkipBack, SkipForward, Square, Volume2, VolumeX } from 'lucide-react';
import type { ActiveMediaState } from '../types/ritm';
import type { AudioEngine } from '../hooks/useAudioEngine';
import type { IslandState } from '../hooks/useIslandState';
import { LevelMeter } from './LevelMeter';
import { usePlayerI18n } from '../i18n';

export interface DynamicIslandProps {
  media: ActiveMediaState | null;
  engine: AudioEngine;
  island: IslandState;
  accent: string;
  /** Lirik sedang tampil → cover pindah ke island. */
  lyricsOn: boolean;
  lyricsAvailable: boolean;
  onToggleLyrics: () => void;
  bookletAvailable: boolean;
  onOpenBooklet: () => void;
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const t = Math.floor(s);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export function DynamicIsland(p: DynamicIslandProps) {
  const { media, engine, island, accent, lyricsOn } = p;
  const { t } = usePlayerI18n();
  const root = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mode = island.mode;
  const expanded = mode === 'expanded';

  // klik di luar / Esc → compact
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) island.collapse();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && island.collapse();
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded, island]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const size: CSSProperties =
    mode === 'expanded'
      ? { width: 'min(440px, calc(100vw - 32px))', height: 172, borderRadius: 36 }
      : mode === 'alert'
        ? { width: 'min(260px, calc(100vw - 32px))', height: 48, borderRadius: 24 }
        : { width: `min(${lyricsOn ? 300 : 280}px, calc(100vw - 32px))`, height: 48, borderRadius: 24 };

  const track = engine.track;
  const progress = engine.duration ? Math.min(1, engine.time / engine.duration) : 0;
  const thumb = (px: number, radius: number) => (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center overflow-hidden bg-neutral-800 dark:bg-neutral-200"
      style={{
        width: lyricsOn ? px : 0,
        height: px,
        marginRight: lyricsOn ? (px > 40 ? 12 : 10) : 0,
        borderRadius: radius,
        opacity: lyricsOn ? 1 : 0,
        transition: `width 600ms ${EASE}, margin 600ms ${EASE}, opacity 400ms ease`,
      }}
    >
      {media?.artworkUrl ? (
        <img src={media.artworkUrl} alt="" className="size-full object-cover" />
      ) : (
        <Disc3 className="size-1/2 text-neutral-500" strokeWidth={1.5} />
      )}
    </span>
  );

  const layer = (on: boolean, children: ReactNode, className = '') => (
    <div
      className={`absolute inset-0 ${className}`}
      aria-hidden={!on}
      inert={!on}
      style={{
        opacity: on ? 1 : 0,
        transform: on ? 'scale(1)' : 'scale(0.96)',
        transition: on ? 'opacity 260ms ease 120ms, transform 320ms ease 120ms' : 'opacity 120ms ease, transform 160ms ease',
        pointerEvents: on ? 'auto' : 'none',
      }}
    >
      {children}
    </div>
  );

  const alert = island.alert;
  const AlertIcon = alert?.kind === 'error' ? AlertCircle : alert?.kind === 'info' ? Info : Check;

  return (
    <div
      ref={root}
      role="region"
      aria-label={t('player.region')}
      className="fixed left-1/2 z-50 overflow-hidden bg-[rgba(10,10,10,0.92)] text-neutral-100 shadow-[0_8px_32px_rgba(0,0,0,0.24),inset_0_0_0_1px_rgba(255,255,255,0.06)] dark:bg-[rgba(250,250,250,0.94)] dark:text-neutral-900 dark:shadow-[0_8px_32px_rgba(0,0,0,0.55),inset_0_0_0_1px_rgba(0,0,0,0.06)]"
      style={{
        ...size,
        bottom: 'max(24px, calc(env(safe-area-inset-bottom) + 16px))',
        transform: `translateX(-50%) translateY(${mode === 'hidden' ? 24 : 0}px)`,
        opacity: mode === 'hidden' ? 0 : 1,
        pointerEvents: mode === 'hidden' ? 'none' : 'auto',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        transition: `width 460ms ${EASE}, height 460ms ${EASE}, border-radius 460ms ${EASE}, transform 400ms ${EASE}, opacity 300ms ease`,
      }}
      onPointerEnter={() => {
        if (mode !== 'compact') return;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(island.expand, 300);
      }}
      onPointerLeave={() => clearTimeout(hoverTimer.current)}
      onPointerMove={island.poke}
      onKeyDown={island.poke}
    >
      {/* ---------- compact ---------- */}
      {layer(
        mode === 'compact',
        <div className="flex h-full items-center pr-1.5 pl-2">
          {thumb(32, 9999)}
          <button
            type="button"
            onClick={island.expand}
            onFocus={island.expand}
            className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch pl-1.5 text-left outline-none"
            aria-label={t('player.openControls', { title: track?.title ?? '' })}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{track?.title}</span>
            <LevelMeter readLevels={engine.readLevels} playing={engine.playing} color={accent} height={14} />
          </button>
          <button
            type="button"
            onClick={engine.toggle}
            aria-label={engine.playing ? t('player.pause') : t('player.play')}
            className="ml-2.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 transition-transform active:scale-95 dark:bg-neutral-900 dark:text-white"
          >
            {engine.playing ? <Pause className="size-3.5" fill="currentColor" /> : <Play className="size-3.5 translate-x-px" fill="currentColor" />}
          </button>
        </div>,
      )}

      {/* ---------- expanded ---------- */}
      {layer(
        expanded,
        <div className="flex h-full flex-col justify-between px-[18px] pt-4 pb-3">
          <div className="flex items-center">
            {thumb(48, 12)}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{track?.title}</p>
              <p className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                {track?.artist}
                {media && media.tracks.length > 1 ? ` · ${engine.trackIndex + 1}/${media.tracks.length}` : ''}
              </p>
            </div>
            {engine.dsp && <DspToggle engine={engine} accent={accent} />}
            <span className="ml-1.5 inline-flex h-5 shrink-0 items-center rounded-full bg-neutral-800 px-2 text-[10px] font-bold tracking-wide text-neutral-300 dark:bg-neutral-200 dark:text-neutral-600">
              {track?.bitrateBadge}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="w-9 text-[11px] tabular-nums" style={{ color: accent }}>{fmt(engine.time)}</span>
            <div className="relative h-4 flex-1">
              <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-neutral-700 dark:bg-neutral-300">
                <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: accent }} />
              </div>
              <input
                type="range"
                aria-label={t('player.seek')}
                min={0}
                max={engine.duration || 1}
                step={0.1}
                value={Math.min(engine.time, engine.duration || 1)}
                onChange={(e) => engine.seek(Number(e.target.value))}
                className="absolute inset-0 w-full cursor-pointer opacity-0"
              />
            </div>
            <span className="w-9 text-right text-[11px] text-neutral-400 tabular-nums dark:text-neutral-500">{fmt(engine.duration)}</span>
          </div>

          <div className="flex items-center justify-between">
            <IconBtn label={engine.muted ? t('player.unmute') : t('player.mute')} onClick={engine.toggleMute}>
              {engine.muted || engine.volume === 0 ? <VolumeX className="size-[18px]" strokeWidth={1.75} /> : <Volume2 className="size-[18px]" strokeWidth={1.75} />}
            </IconBtn>
            <div className="flex items-center gap-1">
              <IconBtn label={t('player.prev')} onClick={engine.prev}>
                <SkipBack className="size-[18px]" fill="currentColor" strokeWidth={1.5} />
              </IconBtn>
              <IconBtn label={t('player.stop')} onClick={engine.stop}>
                <Square className="size-4" fill="currentColor" strokeWidth={1.5} />
              </IconBtn>
              <button
                type="button"
                onClick={engine.toggle}
                aria-label={engine.playing ? t('player.pause') : t('player.play')}
                className="mx-1 inline-flex size-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 transition-transform active:scale-95 dark:bg-neutral-900 dark:text-white"
              >
                {engine.playing ? <Pause className="size-[18px]" fill="currentColor" /> : <Play className="size-[18px] translate-x-px" fill="currentColor" />}
              </button>
              <IconBtn label={t('player.next')} onClick={engine.next} disabled={engine.trackIndex >= engine.trackCount - 1}>
                <SkipForward className="size-[18px]" fill="currentColor" strokeWidth={1.5} />
              </IconBtn>
            </div>
            <div className="flex items-center">
              <IconBtn label={t('player.booklet')} onClick={p.onOpenBooklet} disabled={!p.bookletAvailable}>
                <BookOpen className="size-[18px]" strokeWidth={1.75} />
              </IconBtn>
              <IconBtn label={t('player.lyrics')} onClick={p.onToggleLyrics} disabled={!p.lyricsAvailable} pressed={lyricsOn} accent={accent}>
                <MicVocal className="size-[18px]" strokeWidth={1.75} />
              </IconBtn>
            </div>
          </div>
        </div>,
      )}

      {/* ---------- alert ---------- */}
      {layer(
        mode === 'alert',
        <div className="flex h-full items-center gap-2.5 pr-5 pl-2" role="status" aria-live="polite">
          <span
            className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full ${
              alert?.kind === 'error' ? 'bg-rose-950 text-rose-400 dark:bg-rose-100 dark:text-rose-600' : alert?.kind === 'info' ? 'bg-neutral-800 text-neutral-300 dark:bg-neutral-200 dark:text-neutral-600' : 'bg-emerald-950 text-emerald-400 dark:bg-emerald-100 dark:text-emerald-600'
            }`}
          >
            <AlertIcon className="size-4" strokeWidth={2.25} />
          </span>
          <span className="truncate text-xs font-bold tracking-[0.08em]">{alert?.text}</span>
        </div>,
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  disabled,
  pressed,
  accent,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  accent?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-10 items-center justify-center rounded-full text-neutral-200 transition-colors hover:bg-neutral-800 dark:text-neutral-700 dark:hover:bg-neutral-200 disabled:pointer-events-none disabled:opacity-40"
      style={pressed ? { background: accent, color: '#0a0a0a' } : undefined}
    >
      {children}
    </button>
  );
}

/** Toggle profil dengar Purist ↔ Analog di island (desktop). */
function DspToggle({ engine, accent }: { engine: AudioEngine; accent: string }) {
  const { t, decimal } = usePlayerI18n();
  const dsp = engine.dsp!;
  const analog = dsp.settings.profile === 'analog';
  const guardDb = dsp.stats?.guardActive ? dsp.stats.gainDb : 0;
  const guard = guardDb < -0.01 ? t('player.dsp.guard', { db: Math.abs(guardDb).toFixed(1).replace('.', decimal) }) : '';
  const title = analog ? t('player.dsp.titleAnalog', { guard }) : t('player.dsp.titlePurist');
  const profile = analog ? t('player.profile.analog') : t('player.profile.purist');
  return (
    <button
      type="button"
      onClick={() => dsp.setProfile(analog ? 'purist' : 'analog')}
      aria-label={t('player.profile', { profile })}
      aria-pressed={analog}
      title={title}
      className={`ml-3 inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-bold tracking-wide transition-colors ${
        analog ? 'text-neutral-950' : 'bg-transparent text-neutral-400 ring-1 ring-neutral-700 ring-inset hover:text-neutral-200 dark:text-neutral-500 dark:ring-neutral-300 dark:hover:text-neutral-800'
      }`}
      style={analog ? { background: accent } : undefined}
    >
      {analog ? t('player.dsp.badgeAnalog') : t('player.dsp.badgePurist')}
      {guardDb < -0.01 && <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />}
    </button>
  );
}
