import { span } from "../core/rendering/html";
import { type Accessor, signal } from "../core/signals/signal";
import { getRequestStore } from "../core/ssr-context";
import { globalSingleton } from "../utils/globalSingleton";

type Translations = Record<string, string>;
type LocaleMap = Record<string, Translations>;

/**
 * Interpolation parameters for `t()`, `translated()` and `Trans()`.
 *
 * A value may be a GETTER (a signal accessor or any `() => value`). Getters are
 * called at lookup time, so inside a binding the parameter is tracked exactly
 * like the locale: `translated("hello", { name: userName })` re-renders when
 * either `userName` or the locale changes.
 */
export type TranslationParams = Record<string, string | number | (() => string | number)>;
type Params = TranslationParams;

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
//
// ============================================================================
// LIVE DICTIONARIES
// ============================================================================
//
// The locale was always a signal, but the dictionaries were not: registering
// messages notified nobody. The most common loading flow therefore broke —
//
//     setLocale("es");                        // bindings re-run, "es" is empty
//     registerTranslations("es", await load("es"));   // nobody re-runs
//
// and every binding kept showing raw keys until something unrelated re-ran
// it. `revision` is a counter bumped on every dictionary mutation and read by
// every client-side lookup, so a binding depends on "the active locale AND the
// messages registered for it" rather than on the locale alone.
//
// Adding a field to the shared singleton is backwards compatible, so the key
// stays `v1`. An OLDER copy may have created the object without the field;
// it is attached here on first load of a copy that knows about it. Messages
// registered through that older copy still notify nothing — the degradation is
// the old behaviour, never a crash.
const _i18n = globalSingleton(Symbol.for("sibujs.i18n.v1"), () => ({
  locale: signal("en"),
  locales: Object.create(null) as LocaleMap,
  revision: signal(0),
})) as {
  locale: ReturnType<typeof signal<string>>;
  locales: LocaleMap;
  revision?: ReturnType<typeof signal<number>>;
};
const [clientLocale, setClientLocale] = _i18n.locale;
const locales = _i18n.locales;
const [revision, setRevision] = (_i18n.revision ??= signal(0));

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
 * Subscribe the current reader to dictionary mutations. Client only, for the
 * same reason `getLocale()` never subscribes a request to the client locale: a
 * server render reads once and never re-renders, so the subscription would be
 * machinery nothing uses.
 */
function trackDictionaries(): void {
  if (!getRequestStore()) revision();
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
 *
 * Outside a request the read also subscribes to `revision`, so a binding
 * re-runs when messages are registered after it first rendered — see LIVE
 * DICTIONARIES above.
 */
function lookup(key: string): string | undefined {
  trackDictionaries();
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
 *
 * NOTIFY. Every registration bumps the dictionary revision, so bindings that
 * already rendered a key re-run and pick the new message up — the order of
 * `setLocale()` and `registerTranslations()` no longer matters. The bump comes
 * after publication, so a re-running binding can only ever see the new
 * dictionary.
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
  // NOTIFY — dictionaries are application-global, so this is not scoped to a
  // request: messages registered during a server render are visible to the
  // client bindings that share the process as well.
  setRevision((n) => n + 1);
}

/**
 * Resolve one `{name}` placeholder. Own properties only — a message containing
 * `{toString}` must not reach `Object.prototype` and, now that function values
 * are called, must never CALL an inherited method. A getter is called here, at
 * lookup time, so inside a binding it is tracked like the locale.
 */
function resolveParam(params: Params, name: string): string {
  if (!Object.hasOwn(params, name)) return "";
  const raw = params[name];
  const value = typeof raw === "function" ? raw() : raw;
  return value == null ? "" : String(value);
}

/**
 * Translate `key` in the current locale, falling back to the key itself when it
 * is not registered. A registered empty string is a translation and is returned
 * unchanged; the previous `|| key` discarded it and returned the key.
 *
 * `t()` returns a STRING — a snapshot. It is live only when it is read inside a
 * binding (`span(() => t("hello"))`), because that binding is what re-runs.
 * Called directly in a component body, `span(t("hello"))` renders the message
 * once and never updates. For anything on screen prefer {@link translated},
 * which hands the binding a getter and works for text children and attributes
 * alike. `t()` remains the right call for one-off strings: event handlers,
 * `confirm()` prompts, log lines, server renders.
 *
 * Parameter getters are resolved on every call, so `t("hi", { name: userName })`
 * inside a binding tracks `userName` too.
 */
export function t(key: string, params?: Params): string {
  const message = lookup(key) ?? key;

  return params ? message.replace(/\{(\w+)\}/g, (_, p: string) => resolveParam(params, p)) : message;
}

/**
 * A LIVE translation: returns a getter that re-reads the message every time a
 * binding calls it. Pass it anywhere the tag factories accept a reactive value
 * — a text child or any attribute — and only that one text node or attribute
 * updates when the locale changes, when messages for it are registered later,
 * or when a getter parameter changes. The surrounding elements are never
 * rebuilt, so focus, typed input values and element identity survive a language
 * switch.
 *
 * During SSR the binding evaluates once, using the locale of the current
 * request.
 *
 * @param key Translation key
 * @param params Optional interpolation parameters; values may be getters
 * @returns An accessor producing the translated string
 *
 * @example
 * ```ts
 * const [userName] = signal("Ada");
 *
 * header([
 *   h1(translated("app.title")),
 *   span(translated("greeting", { name: userName })),
 *   input({ placeholder: translated("search.placeholder"), "aria-label": translated("search.label") }),
 * ]);
 *
 * setLocale("es"); // text and attributes update in place — no re-render
 * ```
 */
export function translated(key: string, params?: Params): Accessor<string> {
  return () => t(key, params);
}

/**
 * Trans component — renders a translated string reactively inside a `<span>`.
 * Automatically updates when the client locale changes, when messages for the
 * active locale are registered, and when a getter parameter changes. During SSR
 * it renders once, using the locale belonging to the current request.
 *
 * When no wrapper element is wanted, pass {@link translated} straight to the
 * parent instead: `p(translated("greeting"))`.
 *
 * @param key Translation key
 * @param params Optional interpolation parameters; values may be getters
 * @returns An HTMLElement (span) that reactively shows the translated text
 *
 * @example
 * ```ts
 * registerTranslations("en", { greeting: "Hello, {name}!" });
 * registerTranslations("es", { greeting: "Hola, {name}!" });
 *
 * div([Trans("greeting", { name: userName })]);
 * // When the locale or userName changes, the text updates automatically
 * ```
 */
export function Trans(key: string, params?: Params): HTMLElement {
  return span(translated(key, params));
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
 *
 * Read inside a binding the list is live: registering a new locale re-runs it,
 * so a language picker built from it picks up lazily loaded locales.
 */
export function getAvailableLocales(): string[] {
  trackDictionaries();
  return Object.keys(locales);
}
