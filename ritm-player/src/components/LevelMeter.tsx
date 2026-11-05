import { useEffect, useRef } from 'react';

interface Props {
  readLevels: (out: number[]) => void;
  playing: boolean;
  bars?: number;
  color: string;
  height?: number;
  barWidth?: number;
  gap?: number;
  className?: string;
}

/**
 * Meter level ringan: tinggi batang diperbarui langsung lewat ref per frame (tanpa re-render).
 * Saat jeda batang turun halus ke posisi diam.
 */
export function LevelMeter({ readLevels, playing, bars = 4, color, height = 16, barWidth = 3, gap = 2, className = '' }: Props) {
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const levels = useRef<number[]>(Array(bars).fill(0.2));

  useEffect(() => {
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const raw = Array(bars).fill(0) as number[];
    let id = 0;
    const tick = () => {
      if (playing && !reduce) readLevels(raw);
      for (let i = 0; i < bars; i++) {
        const target = playing ? (reduce ? 0.6 : Math.max(0.15, Math.min(1, (raw[i] ?? 0) * 1.4))) : 0.18;
        const cur = levels.current[i] ?? 0.2;
        // naik cepat, turun pelan
        const next = target > cur ? cur + (target - cur) * 0.55 : cur + (target - cur) * 0.12;
        levels.current[i] = next;
        const el = refs.current[i];
        if (el) el.style.transform = `scaleY(${next.toFixed(3)})`;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, readLevels, bars]);

  return (
    <span aria-hidden="true" className={`inline-flex items-end ${className}`} style={{ height, gap }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          style={{ width: barWidth, height, background: color, borderRadius: 2, transformOrigin: 'bottom', transform: 'scaleY(0.2)' }}
        />
      ))}
    </span>
  );
}
