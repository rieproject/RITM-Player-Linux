import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePlayerI18n } from '../i18n';

export interface BackdropPhoto {
  url: string;
  caption?: string;
}

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Latar galeri: foto bertumpuk, crossfade 1,4 dtk + zoom pelan (Ken Burns) pada foto aktif.
 * Tanpa foto → artwork diperbesar & di-blur; tanpa artwork → warna latar tema.
 */
export function GalleryBackdrop({
  photos,
  index,
  visible,
  fallbackUrl,
  surface,
}: {
  photos: BackdropPhoto[];
  index: number;
  visible: boolean;
  fallbackUrl?: string;
  surface: string;
}) {
  const still = reduceMotion();
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ background: surface, opacity: visible ? 1 : 0, transition: 'opacity 900ms ease' }}
    >
      {photos.length > 0
        ? photos.map((p, i) => {
            const on = i === index;
            return (
              <div key={p.url} className="absolute inset-0" style={{ opacity: on ? 1 : 0, transition: 'opacity 1400ms ease' }}>
                <img
                  src={p.url}
                  alt=""
                  className="size-full object-cover"
                  style={{
                    transform: on && visible && !still ? 'scale(1.08)' : 'scale(1)',
                    // foto aktif zoom pelan; foto yang keluar baru di-reset setelah selesai memudar
                    transition: on ? 'transform 9s linear' : 'transform 0s linear 1.4s',
                  }}
                />
              </div>
            );
          })
        : fallbackUrl && (
            <img src={fallbackUrl} alt="" className="absolute inset-0 size-full scale-125 object-cover blur-3xl" style={{ opacity: 0.7 }} />
          )}
      <div className="absolute inset-0 bg-black/45" />
    </div>
  );
}

/** Kontrol galeri: panah + titik, kanan bawah. */
export function GalleryControls({
  count,
  index,
  onIndex,
  visible,
  caption,
}: {
  count: number;
  index: number;
  onIndex: (i: number) => void;
  visible: boolean;
  caption?: string;
}) {
  const { t } = usePlayerI18n();
  if (count < 2) return null;
  const go = (i: number) => onIndex((i + count) % count);
  return (
    <div
      className="fixed right-4 bottom-[104px] z-40 flex flex-col items-end gap-2 sm:right-8 sm:bottom-11"
      inert={!visible}
      aria-hidden={!visible}
      style={{ opacity: visible ? 1 : 0, transform: `translateY(${visible ? 0 : 8}px)`, transition: 'opacity 600ms ease, transform 600ms ease' }}
    >
      {caption && <p className="max-w-64 truncate rounded-full bg-black/35 px-3 py-1 text-xs text-white/85 backdrop-blur">{caption}</p>}
      <div className="flex items-center gap-1 rounded-full bg-black/35 p-1 text-white backdrop-blur" role="group" aria-label={t('gallery.label')}>
        <button type="button" aria-label={t('gallery.prev')} onClick={() => go(index - 1)} className="inline-flex size-9 items-center justify-center rounded-full hover:bg-white/10">
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t('gallery.photo', { n: i + 1, count })}
              aria-current={i === index}
              onClick={() => go(i)}
              className="h-1.5 rounded-full bg-white"
              style={{ width: i === index ? 18 : 6, opacity: i === index ? 1 : 0.45, transition: 'width 400ms ease, opacity 400ms ease' }}
            />
          ))}
        </div>
        <button type="button" aria-label={t('gallery.next')} onClick={() => go(index + 1)} className="inline-flex size-9 items-center justify-center rounded-full hover:bg-white/10">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
