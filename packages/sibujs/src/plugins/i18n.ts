import { signal, span } from "@sibujs/core";
import { globalSingleton } from "@sibujs/core/internal";

type Translations = Record<string, string>;
type LocaleMap = Record<string, Translations>;
type Params = Record<string, string | number>;

// The active locale and the translation map are shared via globalSingleton so a
// bundler that duplicates the `plugins` chunk doesn't split i18n into two
// worlds (where `setLocale()` in one copy never reaches `t()`/`Trans()` in
// another). NOTE: this state is still process-global — per-request SSR locale
// isolation is a separate follow-up (see TODO.md §C).
const _i18n = globalSingleton(Symbol.for("sibujs.i18n.v1"), () => ({
  locale: signal("en"),
  locales: {} as LocaleMap,
}));
const [currentLocale, setLocaleInternal] = _i18n.locale;
const locales = _i18n.locales;

export function setLocale(locale: string) {
  setLocaleInternal(locale);
}

/**
 * Get the current locale reactively.
 */
export function getLocale(): string {
  return currentLocale();
}

export function registerTranslations(locale: string, messages: Translations) {
  locales[locale] = { ...locales[locale], ...messages };
}

export function t(key: string, params?: Params): string {
  const locale = currentLocale();
  const message = locales[locale]?.[key] || key;

  return params ? message.replace(/\{(\w+)\}/g, (_, p) => String(params[p] ?? "")) : message;
}

/**
 * Trans component — renders a translated string reactively.
 * Automatically updates when the locale changes.
 *
 * @param key Translation key
 * @param params Optional interpolation parameters
 * @returns An HTMLElement (span) that reactively shows the translated text
 *
 * @example
 * ```ts
 * registerTranslations("en", { greeting: "Hello, {name}!" });
 * registerTranslations("es", { greeting: "Hola, {name}!" });
 *
 * div([Trans("greeting", { name: "World" })]);
 * // When locale changes, the text updates automatically
 * ```
 */
export function Trans(key: string, params?: Params): HTMLElement {
  return span(() => t(key, params)) as HTMLElement;
}

/**
 * Check if a translation key exists for the current locale.
 */
export function hasTranslation(key: string): boolean {
  const locale = currentLocale();
  return key in (locales[locale] || {});
}

/**
 * Get all available locales.
 */
export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}
