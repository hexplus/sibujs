import { span } from "../core/rendering/html";
import { signal } from "../core/signals/signal";
import { getRequestStore } from "../core/ssr-context";
import { globalSingleton } from "../utils/globalSingleton";

type Translations = Record<string, string>;
type LocaleMap = Record<string, Translations>;
type Params = Record<string, string | number>;

// ============================================================================
// OWNERSHIP
// ============================================================================
//
// Two pieces of state, two different owners:
//
//   translation dictionaries → APPLICATION-GLOBAL, always
//   active locale            → the CURRENT REQUEST inside an SSR context,
//                              the client otherwise
//
// WHY THE DICTIONARIES STAY GLOBAL. They are static application data:
// registered once at startup, read by every request, never differing between
// them. Copying them per request would duplicate every message for no gain and
// force each request to re-register before it could translate anything.
// Registration merges into the shared map, so adding messages never drops what
// was registered before and a concurrent registration of a different locale
// writes to a different key.
//
// WHY THE ACTIVE LOCALE DOES NOT. It is per-visitor, so on a server it is
// per-request. This used to be a single process-global signal, which is exactly
// right in a browser — one page, one active locale, shared across duplicated
// bundle copies so setLocale() in one copy reaches t() in another — and exactly
// wrong on a server, where two overlapping renders overwrote each other:
//
//     A enters its request, sets "en", awaits
//     B enters its own request, sets "es", renders, finishes
//     A resumes and renders  ->  Spanish
//
// The framework already carries a per-request store backed by
// AsyncLocalStorage (core/ssr-context.ts), so the active locale now lives there
// for the duration of a request. No second AsyncLocalStorage is created, and
// the store is reached only through getRequestStore(), which returns null
// rather than the process global when no request is active — writing request
// state into the global is the bleed this exists to prevent.
//
// The store holds a plain string, not a signal. Reactive locale switching is a
// client concern; a server render reads the value once and never re-renders, so
// giving every request its own signal would allocate subscriber machinery
// nothing will ever use.
//
// ON RUNTIMES WITHOUT AsyncLocalStorage (browser, some edge runtimes) the
// documented limitation is unchanged: runInSSRContext saves and restores the
// one shared store, which is correct for a fully synchronous render and shared
// between two requests that interleave across an await. See
// docs/support-matrix.md.
const _i18n = globalSingleton(Symbol.for("sibujs.i18n.v1"), () => ({
  locale: signal("en"),
  locales: {} as LocaleMap,
}));
const [clientLocale, setClientLocale] = _i18n.locale;
const locales = _i18n.locales;

/**
 * Set the active locale.
 *
 * Inside an SSR request this sets the locale for THAT request only, leaving the
 * application-wide default alone, so one request can never change what a
 * concurrent one renders. Outside a request it updates the client locale
 * reactively, exactly as before.
 */
export function setLocale(locale: string) {
  const request = getRequestStore();
  if (request) {
    request.locale = locale;
    return;
  }
  setClientLocale(locale);
}

/**
 * Get the current locale.
 *
 * Inside an SSR request this is the locale that request selected, or — when it
 * never called `setLocale()` — the application default, which preserves the
 * established `"en"` behaviour while still honouring an application that sets a
 * different default at startup.
 *
 * Outside a request it is the client locale, and the read is reactive: a
 * subscriber re-runs when `setLocale()` changes it.
 */
export function getLocale(): string {
  const request = getRequestStore();
  if (request) {
    // The application default is read only when the request has not chosen a
    // locale, so a server render never subscribes to the client signal for a
    // request that has one of its own.
    return request.locale ?? clientLocale();
  }
  return clientLocale();
}

/**
 * Register translation messages for a locale.
 *
 * Dictionaries are APPLICATION-GLOBAL, including when this is called from
 * inside an SSR request: messages registered anywhere are visible everywhere,
 * and merging preserves whatever was registered before.
 */
export function registerTranslations(locale: string, messages: Translations) {
  locales[locale] = { ...locales[locale], ...messages };
}

export function t(key: string, params?: Params): string {
  const locale = getLocale();
  const message = locales[locale]?.[key] || key;

  return params ? message.replace(/\{(\w+)\}/g, (_, p) => String(params[p] ?? "")) : message;
}

/**
 * Trans component — renders a translated string reactively.
 * Automatically updates when the client locale changes. During SSR it renders
 * once, using the locale belonging to the current request.
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
 * Check if a translation key exists for the current locale — the request's
 * locale during SSR, the client locale otherwise.
 */
export function hasTranslation(key: string): boolean {
  const locale = getLocale();
  return key in (locales[locale] || {});
}

/**
 * Get all available locales. Dictionaries are application-global, so this is
 * the same set inside and outside a request.
 */
export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}
