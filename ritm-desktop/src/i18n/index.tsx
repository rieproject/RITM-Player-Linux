import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PlayerI18nProvider } from '@ritm/player';
import { id, type MessageKey } from './locales/id';
import { en } from './locales/en';

export type { MessageKey };

/**
 * Terjemahan aplikasi desktop.
 * - Bahasa utama: Indonesia (`id`). Kunci yang belum diterjemahkan di bahasa lain otomatis memakai Indonesia.
 * - Menambah bahasa: buat `locales/<kode>.ts` (Partial<Record<MessageKey,string>> bila belum lengkap),
 *   tambahkan kodenya ke `Locale` dan `LOCALES` di bawah.
 */
export type Locale = 'id' | 'en';
export type Dict = Partial<Record<MessageKey, string>>;

export const LOCALES: Record<Locale, { name: string; messages: Dict }> = {
  id: { name: id['lang.name'], messages: id },
  en: { name: en['lang.name'], messages: en },
};
export const LOCALE_ORDER: Locale[] = ['id', 'en'];
export const DEFAULT_LOCALE: Locale = 'id';

const KEY = 'ritm-lang';

function readLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (LOCALE_ORDER as string[]).includes(v)) return v as Locale;
  } catch {}
  return DEFAULT_LOCALE;
}

/** Ganti {nama} dengan nilai dari `vars`. */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {}
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = LOCALES[locale].messages;
    const t = (key: MessageKey, vars?: Record<string, string | number>) => fill(dict[key] ?? id[key], vars);
    return { locale, setLocale, t };
  }, [locale, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      <PlayerI18nProvider locale={locale}>{children}</PlayerI18nProvider>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n harus dipakai di dalam I18nProvider');
  return v;
}
