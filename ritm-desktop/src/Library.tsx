import { Disc3, FolderOpen, FolderSearch, Loader2, X } from 'lucide-react';
import type { RecentItem } from './desktop';
import { useI18n, type MessageKey } from './i18n';

const TYPE: Record<string, MessageKey> = { album: 'type.album', ep: 'type.ep', single: 'type.single' };

/** Layar awal: tombol Buka + rilisan yang terakhir dibuka. */
export function Library({
  items,
  desktop,
  loading,
  currentPath,
  onOpen,
  onPick,
  onRemove,
  onShow,
}: {
  items: RecentItem[];
  desktop: boolean;
  loading: boolean;
  currentPath: string | null;
  onOpen: () => void;
  onPick: (it: RecentItem) => void;
  onRemove: (it: RecentItem) => void;
  onShow: (it: RecentItem) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="flex flex-col items-center text-center">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">{t('library.title')}</h1>
        <p className="mt-2 max-w-sm text-sm text-balance text-neutral-500">
          {t('library.hint')}
        </p>
        <button type="button" onClick={onOpen} disabled={loading} className="btn-primary mt-6 h-11 px-6">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" strokeWidth={1.75} />}
          {loading ? t('library.opening') : t('library.openFile')}
        </button>
        <p className="mt-2 text-[11px] text-neutral-400">Ctrl+O</p>
      </div>

      {desktop && items.length > 0 && (
        <section className="mt-14" aria-labelledby="lib-title">
          <h2 id="lib-title" className="mb-4 flex items-baseline gap-2 text-sm font-semibold">
            {t('library.recent')} <span className="text-xs font-normal text-neutral-400 tabular-nums">{items.length}</span>
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4">
            {items.map((it) => (
              <li key={it.path} className="group relative">
                <button
                  type="button"
                  onClick={() => !it.missing && onPick(it)}
                  disabled={it.missing || loading}
                  className="block w-full text-left disabled:cursor-not-allowed"
                  aria-label={t('library.play', { title: it.title, artist: it.artist })}
                  title={it.path}
                >
                  <span
                    className={`relative block aspect-square overflow-hidden rounded-2xl bg-neutral-200 shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-neutral-900 ${it.missing ? 'opacity-40 grayscale' : ''}`}
                  >
                    {it.cover ? (
                      <img src={it.cover} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                    ) : (
                      <Disc3 className="absolute inset-0 m-auto size-1/4 text-neutral-400" strokeWidth={1.25} aria-hidden />
                    )}
                    {currentPath === it.path && (
                      <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white backdrop-blur">{t('library.nowPlaying')}</span>
                    )}
                  </span>
                  <span className="mt-3 block truncate text-[15px] font-medium" style={currentPath === it.path && it.accent ? { color: it.accent } : undefined}>
                    {it.title || t('library.untitled')}
                  </span>
                  <span className="block truncate text-sm text-neutral-500">{it.artist}</span>
                  <span className="mt-1 block text-[11px] font-medium tracking-[0.08em] text-neutral-400 uppercase tabular-nums">
                    {it.missing
                      ? t('library.missing')
                      : [TYPE[it.type] ? t(TYPE[it.type] as MessageKey) : '', t('library.tracks', { n: it.tracks })].filter(Boolean).join(' · ')}
                  </span>
                </button>
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {!it.missing && (
                    <button type="button" aria-label={t('library.showItem', { title: it.title })} title={t('library.showInFolder')} onClick={() => onShow(it)} className="inline-flex size-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur">
                      <FolderSearch className="size-4" />
                    </button>
                  )}
                  <button type="button" aria-label={t('library.removeItem', { title: it.title })} title={t('library.remove')} onClick={() => onRemove(it)} className="inline-flex size-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-red-600">
                    <X className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
