import { useCallback, useEffect, useRef, useState } from 'react';
import type { IslandAlert, IslandMode } from '../types/ritm';

const IDLE_COLLAPSE_MS = 4000;

/**
 * Mesin state Dynamic Island.
 * - tanpa media → hidden (kecuali ada alert)
 * - alert sementara menimpa mode lain, lalu kembali
 * - expanded menutup sendiri setelah 4 detik tanpa interaksi saat lagu diputar
 */
export function useIslandState({ hasMedia, playing }: { hasMedia: boolean; playing: boolean }) {
  const [base, setBase] = useState<'compact' | 'expanded'>('compact');
  const [alert, setAlert] = useState<IslandAlert | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alertTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const armIdle = useCallback(() => {
    clearTimeout(idle.current);
    if (!playing) return;
    idle.current = setTimeout(() => setBase('compact'), IDLE_COLLAPSE_MS);
  }, [playing]);

  const expand = useCallback(() => {
    setBase('expanded');
    armIdle();
  }, [armIdle]);

  const collapse = useCallback(() => {
    clearTimeout(idle.current);
    setBase('compact');
  }, []);

  /** Panggil saat ada interaksi di dalam island agar tidak menutup sendiri. */
  const poke = useCallback(() => {
    if (base === 'expanded') armIdle();
  }, [base, armIdle]);

  const showAlert = useCallback((a: IslandAlert) => {
    clearTimeout(alertTimer.current);
    setAlert(a);
    alertTimer.current = setTimeout(() => setAlert(null), a.durationMs ?? (a.kind === 'error' ? 2400 : 1800));
  }, []);

  useEffect(() => {
    if (base === 'expanded') armIdle();
    return () => clearTimeout(idle.current);
  }, [playing, base, armIdle]);

  useEffect(() => () => clearTimeout(alertTimer.current), []);

  const mode: IslandMode = alert ? 'alert' : hasMedia ? base : 'hidden';
  return { mode, alert, expand, collapse, poke, showAlert };
}

export type IslandState = ReturnType<typeof useIslandState>;
