import type { MessageKey } from './i18n/locales/id';

/**
 * Pesan error mesin native dibuat dalam bahasa Indonesia oleh sidecar dan proses utama, jadi renderer
 * hanya memakai kodenya dan menerjemahkannya sendiri. Pesan asli tetap dicatat di konsol untuk diagnosis.
 */
const KEYS: Record<string, MessageKey> = {
  DECODE: 'native.err.decode',
  OPEN: 'native.err.open',
  DEVICE: 'native.err.device',
  BACKEND: 'native.err.backend',
  PROTOCOL: 'native.err.protocol',
  CRASHED: 'native.err.crashed',
  PREPARE: 'native.err.prepare',
};

export function nativeErrorKey(code?: string): MessageKey {
  return (code && KEYS[code]) || 'native.err.generic';
}
