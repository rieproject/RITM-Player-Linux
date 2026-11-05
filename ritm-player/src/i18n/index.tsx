import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { playerId, type PlayerMessageKey } from './locales/id';
import { playerEn } from './locales/en';

/**
 * Terjemahan komponen player. Bahasa utama: Indonesia (default bila tanpa provider).
 * Host (mis. desktop) meneruskan `locale` lewat PlayerI18nProvider.
 * Kunci yang belum ada di sebuah bahasa otomatis memakai Indonesia.
 */
export type PlayerLocale = 'id' | 'en';
export type PlayerDict = Partial<Record<PlayerMessageKey, string>>;

export const PLAYER_LOCALES: Record<PlayerLocale, PlayerDict> = { id: playerId, en: playerEn };

export interface PlayerI18n {
  locale: PlayerLocale;
  t: (key: PlayerMessageKey, vars?: Record<string, string | number>) => string;
  /** Pemisah desimal sesuai bahasa (koma untuk Indonesia, titik untuk English). */
  decimal: string;
}

function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

function makeI18n(locale: PlayerLocale): PlayerI18n {
  const dict = PLAYER_LOCALES[locale];
  return {
    locale,
    t: (key, vars) => fill(dict[key] ?? playerId[key], vars),
    decimal: locale === 'en' ? '.' : ',',
  };
}

const DEFAULT_I18N = makeI18n('id');
const PlayerI18nContext = createContext<PlayerI18n>(DEFAULT_I18N);

export function PlayerI18nProvider({ locale = 'id', children }: { locale?: PlayerLocale; children: ReactNode }) {
  const value = useMemo(() => makeI18n(locale), [locale]);
  return <PlayerI18nContext.Provider value={value}>{children}</PlayerI18nContext.Provider>;
}

export function usePlayerI18n(): PlayerI18n {
  return useContext(PlayerI18nContext);
}
