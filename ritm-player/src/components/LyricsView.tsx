import { useLayoutEffect, useRef, useState } from 'react';
import type { LyricLine } from '../types/ritm';
import { activeLyricIndex } from '../format/lrc';

/**
 * Lirik tersinkron: baris aktif di tengah, besar & penuh; tetangga memudar.
 * Kolom digeser (translateY) agar baris aktif selalu di tengah, termasuk baris yang membungkus.
 * Klik baris → lompat ke waktunya.
 */
export function LyricsView({
  lines,
  time,
  onSeek,
  className = '',
  showRoman = true,
}: {
  lines: LyricLine[];
  time: number;
  onSeek: (t: number) => void;
  className?: string;
  /** Tampilkan romanisasi di bawah baris asli (bila baris punya `roman`). */
  showRoman?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLOListElement>(null);
  const [offset, setOffset] = useState(0);
  const active = activeLyricIndex(lines, time);
  const focus = Math.max(0, active);

  useLayoutEffect(() => {
    const measure = () => {
      const el = col.current?.children[focus] as HTMLElement | undefined;
      const h = box.current?.clientHeight ?? 0;
      if (el) setOffset(h / 2 - (el.offsetTop + el.offsetHeight / 2));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
  }, [focus, lines]);

  return (
    <div
      ref={box}
      className={`relative overflow-hidden ${className}`}
      style={{
        maskImage: 'linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)',
      }}
    >
      <ol
        ref={col}
        className="mx-auto flex max-w-4xl flex-col items-center px-6"
        style={{ transform: `translateY(${offset}px)`, transition: 'transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
      >
        {lines.map((l, i) => {
          const d = Math.abs(i - focus);
          const isActive = i === active;
          return (
            <li key={`${i}-${l.time}`} className="w-full py-2">
              <button
                type="button"
                onClick={() => onSeek(l.time)}
                aria-current={isActive || undefined}
                className="block w-full text-center text-[clamp(24px,4.2vw,44px)] leading-tight font-bold tracking-[-0.03em] text-balance text-white outline-none"
                style={{
                  opacity: isActive ? 1 : d === 1 ? 0.42 : d === 2 ? 0.22 : 0.12,
                  transform: `scale(${isActive ? 1 : 0.8})`,
                  transition: 'opacity 500ms ease, transform 500ms ease',
                }}
              >
                {l.text || '♪'}
                {showRoman && l.roman && (
                  <span className="mt-1 block text-[clamp(14px,2vw,20px)] font-medium tracking-normal opacity-80">{l.roman}</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
