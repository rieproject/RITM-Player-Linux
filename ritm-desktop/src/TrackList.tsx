import type { AudioEngine, ActiveMediaState } from '@ritm/player';
import { useI18n } from './i18n';

const fmt = (seconds?: number) => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Opsi 1: daftar editorial yang lapang dengan penanda tipis untuk lagu aktif. */
export function TrackList({
  media,
  engine,
  placement,
}: {
  media: ActiveMediaState;
  engine: AudioEngine;
  placement: 'left' | 'bottom';
}) {
  const bottom = placement === 'bottom';
  const { t } = useI18n();

  return (
    <aside
      aria-label={t('tracklist.title')}
      className="absolute z-20 flex flex-col overflow-hidden"
      style={{
        top: bottom ? 'calc(min(440px, 78vw, 100dvh - 430px) + 148px)' : '16px',
        right: 'auto',
        bottom: bottom ? '84px' : 'auto', // di atas dock pemutar (tinggi ±48 px + jarak)
        left: bottom ? '50%' : 'clamp(18px, 3vw, 48px)',
        width: bottom ? 'min(760px, calc(100vw - 48px))' : 'min(360px, calc(34vw - 24px))',
        height: bottom ? 'auto' : 'min(520px, calc(100% - 228px))',
        minHeight: bottom ? 120 : undefined,
        maxHeight: bottom ? 400 : undefined,
        transform: bottom ? 'translate(-50%, 0)' : 'translate(0, 0)',
        transition: 'top 700ms cubic-bezier(0.2, 0.8, 0.2, 1), left 700ms cubic-bezier(0.2, 0.8, 0.2, 1), width 700ms cubic-bezier(0.2, 0.8, 0.2, 1), height 700ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <div className={`flex shrink-0 items-baseline justify-between gap-3 px-3 ${bottom ? 'pt-3 pb-2' : 'pt-5 pb-3'} border-b border-neutral-200/80 dark:border-zinc-800/80`}>
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-neutral-500 uppercase dark:text-zinc-400">{t('tracklist.title')}</h2>
        <span className="text-[10px] font-medium tracking-[0.08em] text-neutral-400 tabular-nums dark:text-zinc-500">{t('tracklist.count', { n: media.tracks.length })}</span>
      </div>

      <ol className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5">
        {media.tracks.map((track, index) => {
          const active = index === engine.trackIndex;
          const duration = active ? engine.duration || track.duration : track.duration;
          return (
            <li key={`${track.trackNumber}-${track.title}`} className="border-b border-neutral-200/70 last:border-b-0 dark:border-zinc-800/70">
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                aria-label={t('tracklist.play', { n: track.trackNumber, title: track.title })}
                onClick={() => engine.select(index)}
                className={`group relative flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left transition-colors duration-200 hover:bg-neutral-100/80 dark:hover:bg-white/[0.055] ${active ? 'bg-neutral-100/80 dark:bg-white/[0.055]' : ''}`}
              >
                {active && <span className="absolute inset-y-2.5 left-0 w-[2px] rounded-full bg-amber-500" aria-hidden />}
                <span className={`w-8 shrink-0 text-[12px] font-semibold tabular-nums ${active ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-400 dark:text-zinc-500'}`}>
                  {String(track.trackNumber).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[14px] ${active ? 'font-semibold text-neutral-950 dark:text-zinc-50' : 'font-medium text-neutral-700 dark:text-zinc-300'}`}>
                    {track.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-500 dark:text-zinc-500">
                    {track.artist}{active && engine.duration ? ` · ${fmt(engine.time)} / ${fmt(duration)}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-zinc-500">{fmt(duration)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
