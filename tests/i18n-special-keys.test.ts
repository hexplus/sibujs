/**
 * Locale names and translation keys are arbitrary strings, and must behave like
 * arbitrary strings.
 *
 * WHAT WAS WRONG
 * --------------
 * The registry and the dictionaries are objects, and the implementation reached
 * into them with bracket access and `in`, both of which walk the prototype
 * chain. Three separate defects fell out of that:
 *
 * 1. INHERITED KEYS COUNTED AS TRANSLATIONS.
 *
 *        registerTranslations(L, { greeting: "Hello" });
 *        hasTranslation("toString")  ->  true
 *        typeof t("toString")        ->  "function"
 *
 *    `t()` is declared to return a string and returned `Object.prototype.toString`.
 *
 * 2. THE LOCALE NAME `"__proto__"` WAS NOT A LOCALE.
 *    `locales[locale] = dictionary` invoked the inherited `__proto__` SETTER
 *    instead of creating an entry, so the locale never appeared in
 *    `getAvailableLocales()` — and the registry's prototype became the
 *    dictionary, which made every KEY of that dictionary read back as a locale:
 *
 *        registerTranslations("__proto__", { greeting: "Hello" });
 *        locales["greeting"]  ->  { … }   // a locale nobody registered
 *
 * 3. A REGISTERED EMPTY STRING WAS DISCARDED. `locales[l]?.[k] || key` treats
 *    `""` as absent, so an intentionally blank message rendered as its key.
 *
 * WHAT THE FIX IS
 * ---------------
 * Reads go through an own-property check and publication goes through
 * `Object.defineProperty`. The correction is at the operations, not at the
 * initialiser: the i18n singleton is shared across duplicated bundle copies via
 * `globalThis`, so an OLDER copy may have created the registry as an ordinary
 * `{}` before a corrected copy reuses it. The last block below loads the
 * corrected module against exactly that legacy object.
 *
 * Request-scoped locale ownership, client reactivity and the application-global
 * ownership of dictionaries are unchanged — `i18n-ssr-isolation.test.ts` and
 * `i18n-register-reentrancy.test.ts` still hold, and the SSR block here checks
 * that the special-key handling did not carve out an exception to any of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInSSRContext } from "../src/core/ssr-context";
import {
  getAvailableLocales,
  getLocale,
  hasTranslation,
  registerTranslations,
  setLocale,
  t,
} from "../src/plugins/i18n";

const I18N_KEY = Symbol.for("sibujs.i18n.v1");
const SSR_KEY = Symbol.for("sibujs.ssr.v1");

type Registry = Record<symbol, unknown>;
type I18nSingleton = { locale: [() => string, (v: string) => void]; locales: object };

let counter = 0;
/** A locale nothing else in the suite touches. */
const uniqueLocale = () => `zz-keys-${process.pid}-${++counter}`;

/** The live locale registry, reached the same way a duplicated copy would. */
const registry = () => (globalThis as Registry)[I18N_KEY] as I18nSingleton;

/**
 * Run `fn` with `locale` active, restoring the client locale afterwards.
 *
 * Several tests below register locales named after `Object.prototype` members;
 * leaving one of those selected would change what every later suite translates.
 */
function withLocale<T>(locale: string, fn: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale(previous);
  }
}

/** The names that make an ordinary object misbehave. */
const SPECIAL = [
  "__proto__",
  "prototype",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "__defineGetter__",
] as const;

// ── translation keys ────────────────────────────────────────────────────────

describe("inherited properties are not translations", () => {
  it("1-3. `toString`, `constructor` and `hasOwnProperty` are not registered", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { greeting: "Hello" });

    withLocale(locale, () => {
      for (const key of SPECIAL) {
        expect(hasTranslation(key), `${key} was reported as a registered translation`).toBe(false);
        expect(t(key), `${key} did not fall back to itself`).toBe(key);
        expect(typeof t(key), `t(${key}) must be a string`).toBe("string");
      }
      // The real key still works, so the guard did not simply block everything.
      expect(t("greeting")).toBe("Hello");
    });
  });

  it("an inherited property is ignored even when Object.prototype really has one", () => {
    // Defence in depth: a page that pollutes Object.prototype (a common
    // supply-chain symptom) must not be able to inject translations.
    const locale = uniqueLocale();
    registerTranslations(locale, { greeting: "Hello" });
    Object.defineProperty(Object.prototype, "injected", {
      value: "PWNED",
      configurable: true,
      writable: true,
    });
    try {
      withLocale(locale, () => {
        expect(hasTranslation("injected")).toBe(false);
        expect(t("injected")).toBe("injected");
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "injected");
    }
    expect("injected" in {}).toBe(false);
  });

  it("a locale that was never registered translates nothing, whatever it is named", () => {
    for (const name of SPECIAL) {
      withLocale(`unregistered-${name}`, () => {
        expect(hasTranslation("greeting")).toBe(false);
        expect(t("greeting")).toBe("greeting");
      });
    }
  });
});

describe("explicitly registered special keys work", () => {
  it("4-5. `toString` and `constructor` are ordinary keys once registered", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { toString: "STRINGIFY", constructor: "BUILD" });

    withLocale(locale, () => {
      expect(t("toString")).toBe("STRINGIFY");
      expect(t("constructor")).toBe("BUILD");
      expect(hasTranslation("toString")).toBe(true);
      expect(hasTranslation("constructor")).toBe(true);
      // and an unregistered sibling is still absent
      expect(hasTranslation("valueOf")).toBe(false);
    });
  });

  it("6. `__proto__` is an ordinary translation key", () => {
    const locale = uniqueLocale();
    // An object literal's `__proto__:` is a prototype directive, not a property,
    // so the key has to be defined explicitly — exactly as a JSON payload
    // parsed from a translation file would produce it.
    const messages = JSON.parse('{"__proto__":"PROTO","greeting":"Hello"}') as Record<string, string>;
    expect(Object.hasOwn(messages, "__proto__"), "fixture did not carry an own key").toBe(true);

    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("__proto__")).toBe("PROTO");
      expect(hasTranslation("__proto__")).toBe(true);
      expect(t("greeting")).toBe("Hello");
    });
    // and the dictionary's own prototype was not replaced by the value
    const dictionary = (registry().locales as Record<string, object>)[locale];
    expect(Object.getPrototypeOf(dictionary)).toBe(null);
  });

  it("every special name round-trips as a translation key", () => {
    const locale = uniqueLocale();
    const messages: Record<string, string> = {};
    for (const key of SPECIAL) Object.defineProperty(messages, key, { value: `V:${key}`, enumerable: true });

    registerTranslations(locale, messages);

    withLocale(locale, () => {
      for (const key of SPECIAL) {
        expect(t(key), `${key} did not round-trip`).toBe(`V:${key}`);
        expect(hasTranslation(key)).toBe(true);
      }
    });
  });
});

describe("t() returns a registered string or the key", () => {
  it("7. a non-string value never escapes as a translation", () => {
    // TypeScript forbids this; untyped JavaScript does not, and `t()` promises
    // a string to every caller.
    const locale = uniqueLocale();
    const messages = { ok: "OK" } as unknown as Record<string, string>;
    Object.defineProperty(messages, "numeric", { value: 42, enumerable: true });
    Object.defineProperty(messages, "fn", { value: () => "nope", enumerable: true });

    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("ok")).toBe("OK");
      expect(t("numeric")).toBe("numeric");
      expect(t("fn")).toBe("fn");
      expect(typeof t("fn")).toBe("string");
      // hasTranslation() and t() share one definition of "registered", so they
      // cannot disagree about these.
      expect(hasTranslation("numeric")).toBe(false);
      expect(hasTranslation("fn")).toBe(false);
    });
  });

  it("a missing key still falls back to the key itself", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { greeting: "Hello" });
    withLocale(locale, () => {
      expect(t("nothing.here")).toBe("nothing.here");
      expect(hasTranslation("nothing.here")).toBe(false);
    });
  });
});

describe("an empty translation is a translation", () => {
  it("8. a registered empty string is returned as an empty string", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { intentionallyEmpty: "" });
    withLocale(locale, () => {
      expect(t("intentionallyEmpty")).toBe("");
    });
  });

  it("9. hasTranslation() reports a registered empty string as present", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { intentionallyEmpty: "" });
    withLocale(locale, () => {
      expect(hasTranslation("intentionallyEmpty")).toBe(true);
    });
  });

  it("an empty string survives a later merge and can replace a non-empty value", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { label: "Label" });
    registerTranslations(locale, { label: "" });
    withLocale(locale, () => {
      expect(t("label")).toBe("");
      expect(hasTranslation("label")).toBe(true);
    });
  });

  it("an empty template still interpolates to empty", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { blank: "" });
    withLocale(locale, () => {
      expect(t("blank", { name: "World" })).toBe("");
    });
  });
});

describe("10. interpolation is unchanged", () => {
  it("substitutes parameters, leaves unknown ones empty, and interpolates fallbacks", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, {
      greeting: "Hello, {name}!",
      counted: "{count} of {total}",
    });
    withLocale(locale, () => {
      expect(t("greeting", { name: "World" })).toBe("Hello, World!");
      expect(t("counted", { count: 1, total: 3 })).toBe("1 of 3");
      expect(t("greeting", {})).toBe("Hello, !");
      // Fallback keys are interpolated exactly as before.
      expect(t("missing.{name}", { name: "X" })).toBe("missing.X");
    });
  });
});

// ── locale names ────────────────────────────────────────────────────────────

describe("special locale names are ordinary locales", () => {
  it("11-14. `__proto__`, `constructor` and `toString` register and are listed", () => {
    const prototypeBefore = Object.getPrototypeOf(registry().locales);

    registerTranslations("__proto__", { greeting: "PROTO" });
    registerTranslations("constructor", { greeting: "CTOR" });
    registerTranslations("toString", { greeting: "TOSTRING" });

    const available = getAvailableLocales();
    expect(available).toContain("__proto__");
    expect(available).toContain("constructor");
    expect(available).toContain("toString");

    // 16. the registry's own prototype is untouched
    expect(Object.getPrototypeOf(registry().locales)).toBe(prototypeBefore);
  });

  it("15. they remain separate dictionaries", () => {
    registerTranslations("__proto__", { greeting: "PROTO" });
    registerTranslations("constructor", { greeting: "CTOR" });
    registerTranslations("toString", { greeting: "TOSTRING" });

    expect(withLocale("__proto__", () => t("greeting"))).toBe("PROTO");
    expect(withLocale("constructor", () => t("greeting"))).toBe("CTOR");
    expect(withLocale("toString", () => t("greeting"))).toBe("TOSTRING");
  });

  it("16. registering `__proto__` does not turn its keys into phantom locales", () => {
    // The exact symptom of the old setter call: the dictionary became the
    // registry's prototype, so `locales["greeting"]` read back a dictionary.
    registerTranslations("__proto__", { phantom: "PROTO" });
    const locales = registry().locales as Record<string, unknown>;

    expect(Object.getPrototypeOf(locales)).not.toEqual({ phantom: "PROTO" });
    expect(getAvailableLocales()).not.toContain("phantom");
    expect(withLocale("phantom", () => t("phantom"))).toBe("phantom");
  });

  it("17. repeated registration of a special locale merges normally", () => {
    registerTranslations("__proto__", { first: "FIRST" });
    registerTranslations("__proto__", { second: "SECOND" });
    registerTranslations("__proto__", { first: "FIRST-UPDATED" });

    withLocale("__proto__", () => {
      expect(t("first")).toBe("FIRST-UPDATED");
      expect(t("second")).toBe("SECOND");
    });
    // …and appears exactly once
    expect(getAvailableLocales().filter((l) => l === "__proto__")).toHaveLength(1);
  });

  it("18. reentrant registration works for locale `__proto__`", () => {
    const prototypeBefore = Object.getPrototypeOf(registry().locales);
    registerTranslations("__proto__", { base: "BASE" });

    const messages: Record<string, string> = { outer: "OUTER" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations("__proto__", { nested: "NESTED" });
        return "TRIGGER";
      },
    });

    registerTranslations("__proto__", messages);

    withLocale("__proto__", () => {
      expect(t("base")).toBe("BASE");
      expect(t("outer")).toBe("OUTER");
      expect(t("trigger")).toBe("TRIGGER");
      expect(t("nested"), "the nested registration was erased").toBe("NESTED");
    });
    // The nested publication went through defineProperty too, so the registry's
    // own prototype is exactly what it was — whatever that happens to be.
    expect(Object.getPrototypeOf(registry().locales)).toBe(prototypeBefore);
  });

  it("every special name round-trips as a locale name", () => {
    for (const name of SPECIAL) {
      registerTranslations(name, { marker: `M:${name}` });
    }
    const available = getAvailableLocales();
    for (const name of SPECIAL) {
      expect(available, `${name} is not listed`).toContain(name);
      expect(withLocale(name, () => t("marker"))).toBe(`M:${name}`);
    }
  });
});

// ── reentrancy with special keys ────────────────────────────────────────────

describe("19-24. reentrancy still holds, including for special keys", () => {
  it("19. a getter-triggered nested registration survives", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    const messages: Record<string, string> = { outer: "OUTER" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations(locale, { nested: "NESTED" });
        return "TRIGGER";
      },
    });
    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("base")).toBe("BASE");
      expect(t("outer")).toBe("OUTER");
      expect(t("trigger")).toBe("TRIGGER");
      expect(t("nested")).toBe("NESTED");
    });
  });

  it("20. a proxy-triggered nested registration survives", () => {
    const locale = uniqueLocale();
    const backing: Record<string, string> = { outer: "OUTER" };
    const messages = new Proxy(backing, {
      get(target, key, receiver) {
        if (key === "outer") registerTranslations(locale, { nested: "NESTED" });
        return Reflect.get(target, key, receiver);
      },
    });

    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("outer")).toBe("OUTER");
      expect(t("nested")).toBe("NESTED");
    });
  });

  it("21. the outer call's prepared value wins for a conflicting key", () => {
    const locale = uniqueLocale();
    const messages: Record<string, string> = { shared: "OUTER" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations(locale, { shared: "NESTED", only: "ONLY" });
        return "TRIGGER";
      },
    });
    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("shared"), "documented precedence changed").toBe("OUTER");
      expect(t("only"), "a nested key the outer object never mentioned was lost").toBe("ONLY");
    });
  });

  it("22-23. a throwing getter publishes nothing, and the nested commit survives", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    const messages: Record<string, string> = { outer: "OUTER" };
    Object.defineProperty(messages, "boom", {
      enumerable: true,
      get(): string {
        registerTranslations(locale, { nested: "NESTED" });
        throw new Error("getter failed");
      },
    });

    expect(() => registerTranslations(locale, messages)).toThrow("getter failed");

    withLocale(locale, () => {
      expect(t("base"), "a pre-existing key was lost by a failed registration").toBe("BASE");
      expect(t("nested"), "a completed nested registration was rolled back").toBe("NESTED");
      expect(hasTranslation("outer"), "a failed registration published partial state").toBe(false);
      expect(hasTranslation("boom")).toBe(false);
    });
  });

  it("24. special keys stay safe during reentrant registration", () => {
    const locale = uniqueLocale();
    const messages: Record<string, string> = { toString: "OUTER-TOSTRING" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations(locale, JSON.parse('{"__proto__":"NESTED-PROTO"}') as Record<string, string>);
        return "TRIGGER";
      },
    });

    registerTranslations(locale, messages);

    withLocale(locale, () => {
      expect(t("toString")).toBe("OUTER-TOSTRING");
      expect(t("__proto__")).toBe("NESTED-PROTO");
      expect(hasTranslation("valueOf")).toBe(false);
    });
    expect(Object.getPrototypeOf((registry().locales as Record<string, object>)[locale])).toBe(null);
  });
  it("reads the caller's object exactly once, and never after publication", () => {
    // The PREPARE/COMMIT split is only sound if no caller code can run once the
    // live dictionary has been read. Two things prove it: the getter fires
    // exactly once, and the proxy is never touched again afterwards.
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    let getterCalls = 0;
    let sawOwnKeyDuringPrepare: boolean | undefined;
    const backing: Record<string, string> = { plain: "PLAIN" };
    Object.defineProperty(backing, "watched", {
      enumerable: true,
      get() {
        getterCalls++;
        // Publication has not happened yet — the outer call's keys are absent.
        sawOwnKeyDuringPrepare = withLocale(locale, () => hasTranslation("plain"));
        return "WATCHED";
      },
    });

    let trapReads = 0;
    const messages = new Proxy(backing, {
      get(target, key, receiver) {
        trapReads++;
        return Reflect.get(target, key, receiver);
      },
    });

    registerTranslations(locale, messages);
    const readsAtPublication = trapReads;

    expect(getterCalls, "the caller's getter ran more than once").toBe(1);
    expect(sawOwnKeyDuringPrepare, "the merge happened before preparation finished").toBe(false);

    withLocale(locale, () => {
      expect(t("base")).toBe("BASE");
      expect(t("plain")).toBe("PLAIN");
      expect(t("watched")).toBe("WATCHED");
    });
    // Translating does not reach back into the caller's object.
    expect(trapReads, "the caller's object was read again after publication").toBe(readsAtPublication);
    expect(getterCalls).toBe(1);
  });
});

// ── duplicated modules and the legacy singleton ─────────────────────────────

describe("25-31. a corrected copy reusing an OLDER copy's singleton", () => {
  let savedI18n: unknown;
  let savedSSR: unknown;

  beforeEach(() => {
    savedI18n = (globalThis as Registry)[I18N_KEY];
    savedSSR = (globalThis as Registry)[SSR_KEY];
  });

  afterEach(() => {
    if (savedI18n === undefined) delete (globalThis as Registry)[I18N_KEY];
    else (globalThis as Registry)[I18N_KEY] = savedI18n;
    if (savedSSR === undefined) delete (globalThis as Registry)[SSR_KEY];
    else (globalThis as Registry)[SSR_KEY] = savedSSR;
    vi.resetModules();
  });

  /**
   * Publish the singleton exactly as a pre-fix copy would have: an ordinary
   * `{}` registry with `Object.prototype` in its chain, populated by the old
   * bracket-assignment form.
   */
  async function loadAgainstLegacySingleton() {
    vi.resetModules();
    const { signal } = await import("../src/core/signals/signal");
    const legacyLocales: Record<string, Record<string, string>> = {};
    // Data written by the older copy, in the older copy's way.
    legacyLocales.legacy = { greeting: "Legacy hello" };
    (globalThis as Registry)[I18N_KEY] = { locale: signal("en"), locales: legacyLocales };

    const copyA = await import("../src/plugins/i18n");
    vi.resetModules();
    const copyB = await import("../src/plugins/i18n");
    expect(copyB, "the two imports were not distinct module instances").not.toBe(copyA);
    return { copyA, copyB, legacyLocales };
  }

  it("25-26. reuses the legacy registry instead of replacing it", async () => {
    const { copyA, legacyLocales } = await loadAgainstLegacySingleton();
    // Identity is preserved — a new registry would split the two copies into
    // separate i18n worlds.
    expect(registry().locales as object).toBe(legacyLocales);
    expect(Object.getPrototypeOf(legacyLocales), "the legacy object is an ordinary one").toBe(Object.prototype);
    // …and the data the older copy wrote is still readable.
    copyA.setLocale("legacy");
    expect(copyA.t("greeting")).toBe("Legacy hello");
    copyA.setLocale("en");
  });

  it("27. inherited properties are ignored even on the legacy ordinary registry", async () => {
    const { copyA } = await loadAgainstLegacySingleton();
    copyA.registerTranslations("en", { greeting: "Hello" });
    copyA.setLocale("en");

    for (const key of SPECIAL) {
      expect(copyA.hasTranslation(key), `${key} counted as a translation`).toBe(false);
      expect(copyA.t(key)).toBe(key);
    }
    // and a locale named after an inherited member is still unregistered
    copyA.setLocale("toString");
    expect(copyA.t("greeting")).toBe("greeting");
    copyA.setLocale("en");
  });

  it("28. publishing `__proto__` on the legacy registry is safe", async () => {
    const { copyA, legacyLocales } = await loadAgainstLegacySingleton();
    const prototypeBefore = Object.getPrototypeOf(legacyLocales);

    copyA.registerTranslations("__proto__", { greeting: "PROTO" });

    expect(Object.getPrototypeOf(legacyLocales), "the setter ran").toBe(prototypeBefore);
    expect(Object.hasOwn(legacyLocales, "__proto__")).toBe(true);
    expect(copyA.getAvailableLocales()).toContain("__proto__");
    copyA.setLocale("__proto__");
    expect(copyA.t("greeting")).toBe("PROTO");
    copyA.setLocale("en");
  });

  it("a prototype an older copy already corrupted cannot inject a locale", async () => {
    const { copyA, legacyLocales } = await loadAgainstLegacySingleton();
    // Exactly what the pre-fix code did to the registry.
    Object.setPrototypeOf(legacyLocales, { injectedLocale: { greeting: "PWNED" } });
    try {
      copyA.setLocale("injectedLocale");
      expect(copyA.t("greeting"), "an inherited registry entry was used").toBe("greeting");
      expect(copyA.getAvailableLocales()).not.toContain("injectedLocale");
    } finally {
      Object.setPrototypeOf(legacyLocales, Object.prototype);
      copyA.setLocale("en");
    }
  });

  it("29. both copies see the same legitimate translations", async () => {
    const { copyA, copyB } = await loadAgainstLegacySingleton();
    copyA.registerTranslations("es", { greeting: "Hola" });
    copyB.registerTranslations("fr", { greeting: "Bonjour" });

    copyA.setLocale("fr");
    expect(copyA.t("greeting")).toBe("Bonjour");
    expect(copyB.t("greeting")).toBe("Bonjour");
    copyB.setLocale("es");
    expect(copyA.t("greeting")).toBe("Hola");
    expect(copyB.t("greeting")).toBe("Hola");
    expect(copyB.getAvailableLocales()).toEqual(expect.arrayContaining(["legacy", "es", "fr"]));
    copyA.setLocale("en");
  });

  it("30. client locale state stays shared between the copies", async () => {
    const { copyA, copyB } = await loadAgainstLegacySingleton();
    copyA.registerTranslations("es", { greeting: "Hola" });

    copyB.setLocale("es");
    expect(copyA.getLocale()).toBe("es");
    copyA.setLocale("en");
    expect(copyB.getLocale()).toBe("en");
  });

  it("31. the request locale stays shared through the SSR store", async () => {
    const { copyA, copyB } = await loadAgainstLegacySingleton();
    const ssr = await import("../src/core/ssr-context");
    copyA.registerTranslations("en", { greeting: "Hello" });
    copyA.registerTranslations("es", { greeting: "Hola" });

    const inside = await ssr.runInSSRContext(async () => {
      copyA.setLocale("es");
      await Promise.resolve();
      return { a: copyA.t("greeting"), b: copyB.t("greeting"), locale: copyB.getLocale() };
    });

    expect(inside).toEqual({ a: "Hola", b: "Hola", locale: "es" });
    // and the client default was not touched by the request
    expect(copyA.getLocale()).toBe("en");
  });
});

// ── SSR ownership is unchanged ──────────────────────────────────────────────

describe("32-37. request scoping is unaffected by the key handling", () => {
  it("32. two concurrent requests still resolve different locales", async () => {
    const a = uniqueLocale();
    const b = uniqueLocale();
    registerTranslations(a, { greeting: "A" });
    registerTranslations(b, { greeting: "B" });

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });

    const requestA = runInSSRContext(async () => {
      setLocale(a);
      await gate;
      return t("greeting");
    });
    const requestB = runInSSRContext(async () => {
      setLocale(b);
      const seen = t("greeting");
      releaseA();
      return seen;
    });

    // B runs to completion entirely inside A's request; no timers involved.
    expect(await requestB).toBe("B");
    expect(await requestA).toBe("A");
  });

  it("33-34. a special-key locale survives an await and does not become the default", async () => {
    registerTranslations("__proto__", { greeting: "PROTO" });
    const before = getLocale();

    const seen = await runInSSRContext(async () => {
      setLocale("__proto__");
      await Promise.resolve();
      await Promise.resolve();
      return { locale: getLocale(), text: t("greeting"), present: hasTranslation("greeting") };
    });

    expect(seen).toEqual({ locale: "__proto__", text: "PROTO", present: true });
    expect(getLocale(), "a request changed the client default").toBe(before);
  });

  it("35. a dictionary registered during a request is application-global", async () => {
    const locale = uniqueLocale();
    await runInSSRContext(async () => {
      registerTranslations(locale, { inRequest: "", special: "S" });
      return null;
    });

    withLocale(locale, () => {
      expect(hasTranslation("inRequest")).toBe(true);
      expect(t("inRequest"), "an empty registration made during a request was lost").toBe("");
      expect(t("special")).toBe("S");
      expect(hasTranslation("toString")).toBe(false);
    });
    expect(getAvailableLocales()).toContain(locale);
  });

  it("36-37. an unregistered key inside a request falls back without leaking", async () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { greeting: "Hi" });
    const before = getLocale();

    const seen = await runInSSRContext(async () => {
      setLocale(locale);
      return { missing: t("constructor"), has: hasTranslation("constructor") };
    });

    expect(seen).toEqual({ missing: "constructor", has: false });
    expect(getLocale()).toBe(before);
    expect(
      runInSSRContext(() => getLocale()),
      "a request locale leaked into the next one",
    ).toBe(before);
  });
});
