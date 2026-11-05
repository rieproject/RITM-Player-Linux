import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { ActiveMediaState } from '../types/ritm';
import { usePlayerI18n } from '../i18n';

/** Booklet digital. Halaman dibuka seperti buku (page flip); rilisan lama tampil sebagai satu spread. */
export function BookletModal({ media, onClose }: { media: ActiveMediaState; onClose: () => void }) {
  const { t } = usePlayerI18n();
  const close = useRef<HTMLButtonElement>(null);
  const b = media.booklet;
  const pages = b?.pageUrls ?? [];
  const [turned, setTurned] = useState(0); // jumlah halaman yang sudah dibalik ke kiri
  const next = () => setTurned((n) => Math.min(pages.length, n + 1));
  const prev = () => setTurned((n) => Math.max(0, n - 1));

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        setTurned((n) => Math.min(pages.length, n + 1));
      } else if (e.key === 'ArrowLeft') {
        setTurned((n) => Math.max(0, n - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, pages.length]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal="true" aria-labelledby="booklet-title">
      <button type="button" tabIndex={-1} aria-label={t('booklet.close')} onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white text-neutral-900 shadow-[0_24px_80px_rgba(0,0,0,0.35)] dark:bg-neutral-900 dark:text-neutral-100">
        <div className="flex items-center gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-neutral-500">{t('booklet.label')}</p>
            <h2 id="booklet-title" className="truncate text-base font-semibold">
              {media.release.title} <span className="font-normal text-neutral-500">· {media.release.artist}</span>
            </h2>
          </div>
          <button ref={close} type="button" aria-label={t('player.close')} onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto">
          {pages.length > 0 ? (
            <div className="px-6 pt-8">
              <div className="mx-auto flex max-h-[70vh] w-full items-center justify-center gap-3">
                <button
                  type="button"
                  aria-label={t('booklet.prev')}
                  onClick={prev}
                  disabled={turned === 0}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <div className="relative w-full max-w-md [perspective:1800px]" style={{ aspectRatio: '3 / 4' }}>
                  {pages.map((src, i) => {
                    const flipped = i < turned;
                    return (
                      <div
                        key={src}
                        className="absolute inset-0 transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none [backface-visibility:hidden]"
                        style={{
                          transformOrigin: 'left center',
                          transform: flipped ? 'rotateY(-180deg)' : 'rotateY(0deg)',
                          zIndex: flipped ? i + 1 : pages.length - i,
                          transformStyle: 'preserve-3d',
                        }}
                        onClick={() => (flipped ? prev() : next())}
                        role="button"
                        tabIndex={-1}
                      >
                        <img
                          src={src}
                          alt={t('booklet.pageOf', { n: i + 1, max: pages.length })}
                          className="absolute inset-0 size-full rounded-md object-cover shadow-md [backface-visibility:hidden]"
                        />
                        <div
                          aria-label={t('booklet.backPage')}
                          className="absolute inset-0 rounded-md bg-neutral-100 shadow-md [backface-visibility:hidden] [transform:rotateY(180deg)] dark:bg-neutral-800"
                        />
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  aria-label={t('booklet.next')}
                  onClick={next}
                  disabled={turned === pages.length}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                >
                  <ChevronRight className="size-5" />
                </button>
              </div>
              <p className="mt-3 text-center text-xs text-neutral-500 tabular-nums">
                {turned === 0 ? '—' : `${turned} / ${pages.length}`}
              </p>
            </div>
          ) : (
            b?.spreadUrl && <img src={b.spreadUrl} alt={t('booklet.spread')} className="w-full" />
          )}
          {b?.editorialText && (
            <div className="mx-auto max-w-2xl px-6 py-8 text-[15px] leading-relaxed whitespace-pre-line text-neutral-700 dark:text-neutral-300">{b.editorialText}</div>
          )}
          {media.release.catalogNumber && (
            <p className="px-6 pb-6 text-center text-[11px] font-medium tracking-[0.08em] text-neutral-500 uppercase">
              {[media.release.catalogNumber, media.release.year].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
