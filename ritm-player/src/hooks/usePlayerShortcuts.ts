import { useEffect } from 'react';
import type { AudioEngine } from './useAudioEngine';

/**
 * Shortcut global: Space play/pause · ←/→ seek ±5 dtk · ↑/↓ volume · N/P track · L lirik · M mute.
 * Diabaikan saat fokus di input/textarea/select atau elemen contenteditable.
 */
export function usePlayerShortcuts(engine: AudioEngine, opts: { enabled?: boolean; onToggleLyrics?: () => void } = {}) {
  const { enabled = true, onToggleLyrics } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // Space pada tombol yang sedang fokus biarkan jadi klik tombol itu
      if (e.code === 'Space' && t?.tagName === 'BUTTON') return;
      switch (e.key) {
        case ' ':
          engine.toggle();
          break;
        case 'ArrowLeft':
          engine.seekBy(-5);
          break;
        case 'ArrowRight':
          engine.seekBy(5);
          break;
        case 'ArrowUp':
          engine.setVolume(engine.volume + 0.1);
          break;
        case 'ArrowDown':
          engine.setVolume(engine.volume - 0.1);
          break;
        case 'n':
        case 'N':
          engine.next();
          break;
        case 'p':
        case 'P':
          engine.prev();
          break;
        case 'm':
        case 'M':
          engine.toggleMute();
          break;
        case 'l':
        case 'L':
          onToggleLyrics?.();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, enabled, onToggleLyrics]);
}
