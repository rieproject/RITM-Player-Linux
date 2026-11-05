import { useEffect, useRef } from 'react';
import { RitmLogo } from '@ritm/player';

const HOLD_MS = 1500;
const FADE_MS = 500;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * Animasi pembuka di dalam jendela: logo muncul, lalu merek memudar keluar dan layar utama terlihat.
 * Sekitar 2 detik; klik untuk melewati. Gerakan dikurangi bila sistem meminta reduced motion.
 */
export function IntroAnimation({ onDone }: { onDone: () => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLParagraphElement>(null);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const anims: Animation[] = [];
    const timers: number[] = [];

    const finish = () => {
      if (done.current) return;
      done.current = true;
      anims.forEach((a) => a.cancel());
      const el = overlay.current;
      if (!el) return onDoneRef.current();
      const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease', fill: 'forwards' });
      fade.onfinish = () => onDoneRef.current();
    };

    if (logo.current) {
      anims.push(
        logo.current.animate(
          reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }],
          { duration: reduce ? 300 : 800, easing: EASE, fill: 'both' },
        ),
      );
    }
    if (label.current) {
      anims.push(
        label.current.animate(
          reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: reduce ? 300 : 600, delay: reduce ? 0 : 350, easing: EASE, fill: 'both' },
        ),
      );
    }

    timers.push(window.setTimeout(finish, reduce ? 800 : HOLD_MS));
    const skip = () => finish();
    window.addEventListener('keydown', skip, { once: true });
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', skip);
      anims.forEach((a) => a.cancel());
    };
  }, []);

  return (
    <div
      ref={overlay}
      role="img"
      aria-label="RITM Player"
      onClick={() => {
        if (!done.current) {
          done.current = true;
          onDoneRef.current();
        }
      }}
      className="fixed inset-0 z-[90] flex cursor-pointer flex-col items-center justify-center gap-4 bg-neutral-950 text-white"
    >
      <div ref={logo} className="flex flex-col items-center gap-5">
        <RitmLogo className="h-14 w-auto" title="RITM" variant="white" />
      </div>
      <p ref={label} className="text-[13px] font-semibold tracking-[0.42em] uppercase opacity-60">
        /Player
      </p>
    </div>
  );
}
