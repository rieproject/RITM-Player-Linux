import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RitmMood, RitmMoodPreset } from '../types/ritm';

export interface MoodCanvasProps {
  mood: RitmMood;
  /** Level audio 0–1 per pita (dari useAudioEngine). Tanpa ini animasi tetap jalan, tanpa reaksi musik. */
  readLevels?: (out: number[]) => void;
  playing?: boolean;
  /** false → loop berhenti (hemat baterai saat tidak terlihat). */
  active?: boolean;
  className?: string;
}

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** PRNG kecil agar susunan tiap preset konsisten (tidak berubah tiap render). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Audio {
  bass: number;
  mid: number;
  high: number;
}

interface Scene {
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number, a: Audio): void;
}

/** Resolusi internal relatif terhadap ukuran CSS; preset lembut cukup setengah resolusi. */
const SCALE: Record<RitmMoodPreset, number> = { aurora: 0.5, fog: 0.4, waves: 0.75, particles: 1, rain: 1 };

function makeScene(preset: RitmMoodPreset, colors: RGB[], energy: number): Scene {
  const r = rng(preset.length * 7919 + colors.length);
  const col = (i: number) => colors[i % colors.length]!;

  switch (preset) {
    case 'aurora': {
      const blobs = Array.from({ length: 5 }, (_, i) => ({ c: col(i), ph: r() * 6.28, fx: 0.3 + r() * 0.5, fy: 0.2 + r() * 0.4, size: 0.32 + r() * 0.18 }));
      return {
        draw(ctx, w, h, t, _dt, a) {
          ctx.globalCompositeOperation = 'lighter';
          const m = Math.max(w, h);
          for (const b of blobs) {
            const x = w * (0.5 + 0.38 * Math.sin(t * b.fx + b.ph));
            const y = h * (0.42 + 0.3 * Math.cos(t * b.fy + b.ph * 1.3));
            const rad = m * b.size * (1 + a.bass * 0.35);
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0, rgba(b.c, 0.5 + a.mid * 0.25));
            g.addColorStop(1, rgba(b.c, 0));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
          }
        },
      };
    }

    case 'fog': {
      const banks = Array.from({ length: 7 }, (_, i) => ({ c: col(i), x: r(), y: 0.25 + r() * 0.6, v: 0.01 + r() * 0.02, size: 0.4 + r() * 0.3, ph: r() * 6.28 }));
      return {
        draw(ctx, w, h, t, dt, a) {
          ctx.globalCompositeOperation = 'lighter';
          const m = Math.max(w, h);
          for (const b of banks) {
            b.x += b.v * dt * (0.6 + energy);
            if (b.x > 1.4) b.x = -0.4;
            const x = w * b.x;
            const y = h * (b.y + 0.04 * Math.sin(t * 0.3 + b.ph));
            const rad = m * b.size * (1 + a.bass * 0.15);
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0, rgba(b.c, 0.16 + a.mid * 0.1));
            g.addColorStop(1, rgba(b.c, 0));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
          }
        },
      };
    }

    case 'waves': {
      const layers = Array.from({ length: 4 }, (_, i) => ({ c: col(i), ph: r() * 6.28, k: 1.2 + r() * 1.6, base: 0.5 + i * 0.1 }));
      return {
        draw(ctx, w, h, t, _dt, a) {
          ctx.globalCompositeOperation = 'source-over';
          layers.forEach((L, i) => {
            const amp = h * (0.035 + 0.02 * i) * (1 + a.bass * 1.6);
            const top = h * L.base;
            ctx.beginPath();
            ctx.moveTo(0, h);
            for (let x = 0; x <= w + 8; x += 8) {
              const u = x / w;
              const y = top + amp * Math.sin(u * L.k * 6.28 + t * (0.6 + i * 0.25) + L.ph) + amp * 0.4 * Math.sin(u * 13 - t * 1.1 + L.ph);
              ctx.lineTo(x, y);
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            const g = ctx.createLinearGradient(0, top - amp, 0, h);
            g.addColorStop(0, rgba(L.c, 0.42 + a.mid * 0.2));
            g.addColorStop(1, rgba(L.c, 0.05));
            ctx.fillStyle = g;
            ctx.fill();
          });
        },
      };
    }

    case 'particles': {
      const ps = Array.from({ length: 80 }, (_, i) => ({ c: col(i), x: r(), y: r(), s: 0.6 + r() * 1.8, v: 0.015 + r() * 0.04, ph: r() * 6.28 }));
      return {
        draw(ctx, w, h, t, dt, a) {
          ctx.globalCompositeOperation = 'lighter';
          const unit = Math.min(w, h) / 220;
          for (const p of ps) {
            p.y -= p.v * dt * (0.5 + energy) * (1 + a.mid);
            if (p.y < -0.05) {
              p.y = 1.05;
              p.x = Math.random();
            }
            const x = w * (p.x + 0.02 * Math.sin(t * 0.7 + p.ph));
            const y = h * p.y;
            const rad = unit * p.s * (1 + a.high * 2.2);
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 5);
            g.addColorStop(0, rgba(p.c, 0.9));
            g.addColorStop(0.2, rgba(p.c, 0.35));
            g.addColorStop(1, rgba(p.c, 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, rad * 5, 0, 6.283);
            ctx.fill();
          }
        },
      };
    }

    case 'rain': {
      const drops = Array.from({ length: 160 }, (_, i) => ({ c: col(i), x: r(), y: r(), len: 0.025 + r() * 0.06, v: 0.5 + r() * 0.7, a: 0.2 + r() * 0.45 }));
      return {
        draw(ctx, w, h, _t, dt, a) {
          ctx.globalCompositeOperation = 'source-over';
          const slant = 0.12 + energy * 0.18;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1, Math.min(w, h) / 600);
          for (const d of drops) {
            d.y += d.v * dt * (0.5 + energy * 0.9);
            d.x += d.v * dt * (0.5 + energy * 0.9) * slant * (h / w);
            if (d.y > 1.1) {
              d.y = -0.1;
              d.x = Math.random() * 1.2 - 0.2;
            }
            const x = w * d.x;
            const y = h * d.y;
            const L = h * d.len;
            ctx.strokeStyle = rgba(d.c, d.a * (0.7 + a.bass * 0.8));
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - L * slant, y - L);
            ctx.stroke();
          }
        },
      };
    }
  }
}

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animasi latar generatif per lagu. Digambar di <canvas> transparan,
 * bergerak lebih hidup mengikuti pita bass/mid/high dari analyser audio.
 */
export function MoodCanvas({ mood, readLevels, playing = false, active = true, className = '' }: MoodCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ readLevels, playing });
  live.current = { readLevels, playing };
  const colorsKey = mood.colors.join(',');
  const energy = Math.max(0, Math.min(1, mood.energy ?? 0.5));

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const colors = colorsKey.split(',').filter(Boolean).map(hexToRgb);
    if (!colors.length) colors.push([245, 158, 11]);
    const scene = makeScene(mood.preset, colors, energy);
    const scale = SCALE[mood.preset] * Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
    const still = reduceMotion();

    let w = 0;
    let h = 0;
    let painted = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = document.createElement('canvas');
    const snapshotCtx = snapshot.getContext('2d');

    const applySize = (nextW: number, nextH: number) => {
      if (el.width === nextW && el.height === nextH) return;
      if (painted && snapshotCtx && el.width > 0 && el.height > 0) {
        snapshot.width = el.width;
        snapshot.height = el.height;
        snapshotCtx.drawImage(el, 0, 0);
      }
      el.width = nextW;
      el.height = nextH;
      w = nextW;
      h = nextH;
      // Changing the canvas resolution clears it; put the last frame back so
      // the next animation frame never exposes a blank background.
      if (painted && snapshot.width > 0 && snapshot.height > 0) {
        ctx.drawImage(snapshot, 0, 0, nextW, nextH);
      }
    };

    const resize = () => {
      clearTimeout(resizeTimer);
      const rect = el.getBoundingClientRect();
      const nextW = Math.max(1, Math.round(rect.width * scale));
      const nextH = Math.max(1, Math.round(rect.height * scale));
      if (el.width === nextW && el.height === nextH) return;
      if (!painted) {
        applySize(nextW, nextH);
        return;
      }
      // Let CSS scale the current frame while the user is dragging the window.
      // Resize the backing store once the resize stream settles.
      resizeTimer = setTimeout(() => applySize(nextW, nextH), 120);
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(el);

    const raw = [0, 0, 0, 0, 0, 0];
    const au: Audio = { bass: 0, mid: 0, high: 0 };
    const speed = 0.35 + energy * 0.9;
    let t = Math.random() * 100;
    let last = performance.now();
    let id = 0;

    const frame = (nowMs: number) => {
      const dt = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;
      const { readLevels: rl, playing: pl } = live.current;
      if (pl && rl && !still) rl(raw);
      else raw.fill(0);
      const react = 0.6 + energy * 0.8;
      const ease = (cur: number, target: number) => cur + (target - cur) * (target > cur ? 0.35 : 0.08);
      au.bass = ease(au.bass, Math.min(1, ((raw[0]! + raw[1]!) / 2) * react));
      au.mid = ease(au.mid, Math.min(1, ((raw[2]! + raw[3]!) / 2) * react));
      au.high = ease(au.high, Math.min(1, ((raw[4]! + raw[5]!) / 2) * react * 1.4));
      // saat jeda tetap bergerak sangat pelan
      t += dt * speed * (pl ? 1 : 0.25);
      ctx.clearRect(0, 0, w, h);
      scene.draw(ctx, w, h, t, still ? 0 : dt * (pl ? 1 : 0.25), au);
      painted = true;
      if (!still) id = requestAnimationFrame(frame);
    };

    if (active) id = requestAnimationFrame(frame);
    else frame(last); // tetap gambar satu frame agar tidak kosong saat muncul

    return () => {
      cancelAnimationFrame(id);
      clearTimeout(resizeTimer);
      ro?.disconnect();
    };
  }, [mood.preset, colorsKey, energy, active]);

  return <canvas ref={canvas} aria-hidden="true" className={`pointer-events-none block size-full ${className}`} />;
}

/** Simpan elemen lama sebentar agar bisa memudar keluar saat kunci berganti (mis. pindah lagu). */
export function useCrossfade<T>(key: string, value: T, ms = 1400) {
  const [leaving, setLeaving] = useState<{ key: string; value: T }[]>([]);
  const prev = useRef({ key, value });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const old = prev.current;
    prev.current = { key, value };
    if (old.key === key) return;
    setLeaving((l) => [...l.filter((x) => x.key !== old.key && x.key !== key), old]);
    timers.current.push(setTimeout(() => setLeaving((l) => l.filter((x) => x !== old)), ms));
  }, [key, value, ms]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return [...leaving.filter((x) => x.key !== key).map((x) => ({ ...x, leaving: true })), { key, value, leaving: false }];
}

/** Lapisan yang memudar masuk saat dipasang dan memudar keluar saat `leaving`. */
export function FadeLayer({ leaving, ms = 1400, className = '', children }: { leaving: boolean; ms?: number; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={`absolute inset-0 ${className}`} style={{ opacity: shown && !leaving ? 1 : 0, transition: `opacity ${ms}ms ease` }}>
      {children}
    </div>
  );
}
