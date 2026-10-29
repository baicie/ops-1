import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en from './catalogs/en.json';
import zhCN from './catalogs/zh-CN.json';

/** Every message key the shell knows about. Derived from the default catalog so a
 *  new key can never be added to `en` without the other locales being typed against it. */
export type MessageKey = keyof typeof en;

export type Locale = 'en' | 'zh-CN';

/** Named interpolation values; placeholders are written as `{name}` in the catalog. */
export type TranslateParams = Record<string, string | number>;

/** First paint for a visitor with no stored preference: the product ships Chinese. */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh-CN'];

export const LOCALE_STORAGE_KEY = 'opsweave-locale';

/** Compile-time guard: a key missing from zh-CN fails `tsc --noEmit`. */
const zhCNMessages: Record<MessageKey, string> = zhCN;

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-CN': zhCNMessages,
};

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Pure translation entry point for code outside React (a message key that the
 * default catalog does not have cannot be expressed here, by type).
 */
export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const message = catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key;
  return interpolate(message, params);
}

/**
 * UTC build timestamp rendered through `Intl` yet kept byte-identical to the
 * previous hand-sliced ISO output (`YYYY-MM-DD HH:MM UTC`): the deployment badge
 * is asserted in tests and must not drift per browser locale.
 */
export function formatUtcDateTime(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} UTC`;
}

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); fall back to default.
  }
  return DEFAULT_LOCALE;
}

/** Locale to use on first paint, before React mounts. */
export function resolveInitialLocale(): Locale {
  return readStoredLocale();
}

/** Keeps `<html lang>` truthful for assistive tech and for CSS/JS language hooks. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: TranslateParams) => string;
  formatDateTime: (value: string | number | Date) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(readStoredLocale);

  useEffect(() => {
    applyDocumentLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Persistence is best-effort; the in-memory locale still applies.
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    formatDateTime: (target) => formatUtcDateTime(locale, target),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

/** Convenience hook for components that only translate. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
