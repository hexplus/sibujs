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
//
// ============================================================================
// PROTOTYPE SAFETY
// ============================================================================
//
// A locale name and a translation key are arbitrary caller-supplied STRINGS,
// but the registry and the dictionaries are objects, and bracket access on an
// ordinary object consults `Object.prototype`. Every lookup therefore answered
// for keys nobody registered:
//
//     registerTranslations(locale, { greeting: "Hello" });
//     hasTranslation("toString")   -> true
//     typeof t("toString")         -> "function"   (t() promises a string)
//
// and publication was worse. `locales[locale] = dictionary` for the locale name
// `"__proto__"` does not create an entry at all — it invokes the inherited
// `__proto__` SETTER and replaces the registry's prototype with the dictionary,
// so the locale is missing from getAvailableLocales() while every one of its
// KEYS becomes a phantom locale: after registering `{ greeting: "Hello" }` under
// `"__proto__"`, `locales["greeting"]` reads back `"Hello"`.
//
// The correction is at the access and publication operations themselves, not at
// the initialiser. `locales: Object.create(null)` alone would not be enough:
// this singleton is deliberately shared across duplicated bundle copies through
// `globalThis`, so an OLDER copy of the framework may have created it as an
// ordinary `{}` before a corrected copy loads and reuses it. Reads are guarded
// with `Object.hasOwn` and publication goes through `Object.defineProperty`,
// both of which are correct whichever object the registry turns out to be. The
// null prototype is kept as defence in depth for the case where this copy
// creates it first.
const _i18n = globalSingleton(Symbol.for("sibujs.i18n.v1"), () => ({
  locale: signal("en"),
  locales: Object.create(null) as LocaleMap,
}));
const [clientLocale, setClientLocale] = _i18n.locale;
const locales = _i18n.locales;

/**
 * The dictionary registered under `locale`, or `undefined`. Own properties
 * only: an inherited member of `Object.prototype` is not a registered locale,
 * and neither is an entry left on the prototype by an older copy that published
 * `"__proto__"` through the setter.
 */
function dictionaryFor(locale: string): Translations | undefined {
  return Object.hasOwn(locales, locale) ? locales[locale] : undefined;
}

/**
 * The message registered under `key` for the active locale, or `undefined` when
 * there is none. This is the single definition of "registered", so `t()` and
 * `hasTranslation()` can never disagree.
 *
 * A registered EMPTY STRING is a message like any other and is returned as one;
 * only a genuinely absent key yields `undefined`. The non-string guard keeps the
 * `string` return type honest at runtime — untyped JavaScript can put anything
 * in a dictionary, and returning `Object.prototype.toString` from `t()` is
 * exactly the bug this replaces.
 */
function lookup(key: string): string | undefined {
  const dictionary = dictionaryFor(getLocale());
  if (dictionary === undefined || !Object.hasOwn(dictionary, key)) return undefined;
  const message = dictionary[key];
  return typeof message === "string" ? message : undefined;
}

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
 *
 * PREPARE, THEN COMMIT. `messages` is caller-controlled, and spreading it runs
 * the caller's property getters and proxy traps — arbitrary synchronous code
 * that can call this function again. Merging in a single expression
 *
 *     locales[locale] = { ...locales[locale], ...messages };
 *
 * captures the dictionary BEFORE that code runs and writes it back after, so a
 * nested registration that committed in between is silently erased. Copying
 * `messages` first leaves a plain object with no getters left, so by the time
 * the live dictionary is read for the merge no caller code can run again.
 *
 * Precedence, deliberately: the outer call's prepared values win over a nested
 * call's for the same key — it is the registration the caller asked for last,
 * and its value was computed from what it intended to publish. Nested keys the
 * outer object does not mention survive untouched.
 *
 * A getter that throws leaves the dictionary exactly as it was: preparation has
 * published nothing. A nested registration that completed before the throw is
 * unaffected, because it committed on its own.
 *
 * Publication uses `Object.defineProperty` rather than `locales[locale] = ...`,
 * because the assignment form would invoke the inherited `__proto__` setter for
 * a locale of that name instead of registering it. Locale names and translation
 * keys are treated literally throughout — see PROTOTYPE SAFETY above.
 */
export function registerTranslations(locale: string, messages: Translations) {
  // PREPARE — every getter and proxy trap in `messages` runs here. Spreading
  // first leaves a plain data object, so nothing below can run caller code.
  const prepared = { ...messages };
  // COMMIT — the live dictionary is read only now, after all caller code has
  // finished, and merged into one new dictionary. Own keys only, on both sides.
  const merged: Translations = Object.assign(Object.create(null), dictionaryFor(locale), prepared);
  // PUBLISH — one own, enumerable data property, whatever the locale is named.
  Object.defineProperty(locales, locale, {
    value: merged,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Translate `key` in the current locale, falling back to the key itself when it
 * is not registered. A registered empty string is a translation and is returned
 * unchanged; the previous `|| key` discarded it and returned the key.
 */
export function t(key: string, params?: Params): string {
  const message = lookup(key) ?? key;

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
 *
 * Registered keys only. `toString`, `constructor` and the rest of
 * `Object.prototype` are not translations unless an application registers them,
 * and a registered empty string counts as present.
 */
export function hasTranslation(key: string): boolean {
  return lookup(key) !== undefined;
}

/**
 * Get all available locales. Dictionaries are application-global, so this is
 * the same set inside and outside a request.
 *
 * Own enumerable keys, so a locale is listed exactly when it was registered -
 * including one named `"__proto__"`, which publication now stores literally.
 */
export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}
