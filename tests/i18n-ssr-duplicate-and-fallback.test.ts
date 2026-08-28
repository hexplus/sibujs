/**
 * i18n request-locale ownership under two conditions the main isolation suite
 * cannot reach in-process: duplicated module copies, and a runtime with no
 * `AsyncLocalStorage`.
 *
 * WHY THESE ARE SEPARATE
 * ----------------------
 * Both require re-importing the framework with a manipulated module registry,
 * which would disturb every other test sharing the file. `vi.resetModules()`
 * plus a fresh dynamic import gives a genuinely distinct module instance — the
 * same technique `duplicate-instance-source.test.ts` uses.
 *
 * WHAT THEY PIN
 * -------------
 * 1. DUPLICATE COPIES. A bundler that pre-bundles dependencies can produce two
 *    physical copies of the plugins chunk. Both must resolve the SAME
 *    request-local locale inside one request — the whole reason the SSR store's
 *    `AsyncLocalStorage` is published on `globalThis` — and must continue to
 *    share the client-global locale outside one.
 *
 * 2. NO AsyncLocalStorage. On a browser or an edge runtime without it, the
 *    documented behaviour is that `runInSSRContext` saves and restores the one
 *    shared store. That is correct for a fully synchronous render and shared
 *    between requests that interleave across an `await` — a limitation this
 *    change must preserve exactly, not silently alter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SSR_KEY = Symbol.for("sibujs.ssr.v1");
const I18N_KEY = Symbol.for("sibujs.i18n.v1");

type Registry = Record<symbol, unknown>;

/** Restore whatever the shared registries held before a test rewired them. */
let savedSSR: unknown;
let savedI18n: unknown;

beforeEach(() => {
  savedSSR = (globalThis as Registry)[SSR_KEY];
  savedI18n = (globalThis as Registry)[I18N_KEY];
});

afterEach(() => {
  if (savedSSR === undefined) delete (globalThis as Registry)[SSR_KEY];
  else (globalThis as Registry)[SSR_KEY] = savedSSR;
  if (savedI18n === undefined) delete (globalThis as Registry)[I18N_KEY];
  else (globalThis as Registry)[I18N_KEY] = savedI18n;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("duplicated module copies", () => {
  it("two copies resolve the SAME request locale inside one request", async () => {
    vi.resetModules();
    const ssr = await import("../src/core/ssr-context");
    const copyA = await import("../src/plugins/i18n");
    // A second physical copy of the plugin chunk, as dependency pre-bundling
    // can produce.
    vi.resetModules();
    const copyB = await import("../src/plugins/i18n");

    expect(copyB, "the two imports were not distinct module instances").not.toBe(copyA);

    copyA.registerTranslations("en", { greeting: "Hello" });
    copyA.registerTranslations("es", { greeting: "Hola" });

    const inside = await ssr.runInSSRContext(async () => {
      // One copy selects the locale…
      copyA.setLocale("es");
      await Promise.resolve();
      // …and the other must see it, because both reach the same request store
      // through the AsyncLocalStorage published on globalThis.
      return {
        aLocale: copyA.getLocale(),
        bLocale: copyB.getLocale(),
        aText: copyA.t("greeting"),
        bText: copyB.t("greeting"),
      };
    });

    expect(inside).toEqual({ aLocale: "es", bLocale: "es", aText: "Hola", bText: "Hola" });
  });

  it("two copies keep sharing the CLIENT locale outside a request", async () => {
    vi.resetModules();
    const copyA = await import("../src/plugins/i18n");
    vi.resetModules();
    const copyB = await import("../src/plugins/i18n");

    copyA.registerTranslations("en", { greeting: "Hello" });
    copyA.registerTranslations("fr", { greeting: "Bonjour" });

    copyA.setLocale("fr");
    // The documented browser guarantee: setLocale in one copy reaches t() in
    // another, because the signal lives in a globalSingleton.
    expect(copyB.getLocale()).toBe("fr");
    expect(copyB.t("greeting")).toBe("Bonjour");

    copyB.setLocale("en");
    expect(copyA.t("greeting")).toBe("Hello");
  });

  it("a request in one copy does not disturb the client locale either copy sees", async () => {
    vi.resetModules();
    const ssr = await import("../src/core/ssr-context");
    const copyA = await import("../src/plugins/i18n");
    vi.resetModules();
    const copyB = await import("../src/plugins/i18n");

    copyA.registerTranslations("en", { greeting: "Hello" });
    copyA.registerTranslations("es", { greeting: "Hola" });
    copyA.setLocale("en");

    await ssr.runInSSRContext(async () => {
      copyB.setLocale("es");
      return null;
    });

    expect(copyA.getLocale()).toBe("en");
    expect(copyB.getLocale()).toBe("en");
  });
});

describe("a runtime without AsyncLocalStorage", () => {
  /**
   * Load a fresh framework instance whose ALS detection fails, so
   * `runInSSRContext` takes the shared-store fallback path.
   */
  async function loadWithoutALS() {
    delete (globalThis as Registry)[I18N_KEY];
    // Pre-seed the shared registry exactly as a first copy would have published
    // it, but with `als: null`. The module reads the registry with `??=`, so
    // detection never runs and the fallback path is forced deterministically.
    //
    // Suppressing `process.getBuiltinModule` instead is NOT reliable: the
    // CommonJS `require` branch still finds `node:async_hooks` under the test
    // runner, so the block would silently re-test the AsyncLocalStorage path.
    // The guard test below fails loudly if that ever happens again.
    (globalThis as Registry)[SSR_KEY] = {
      als: null,
      fallbackStore: { ssr: false, suspenseIdCounter: 0, locale: undefined },
      fallbackDepth: 0,
    };
    vi.resetModules();
    const ssr = await import("../src/core/ssr-context");
    const i18n = await import("../src/plugins/i18n");
    return { ssr, i18n };
  }

  it("really is running without AsyncLocalStorage, and warns about it", async () => {
    // Guard for every test in this block. If ALS were still available these
    // tests would silently be re-testing the AsyncLocalStorage path and proving
    // nothing about the fallback, so the branch is confirmed by the warning the
    // runtime is documented to emit exactly here.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ssr, i18n } = await loadWithoutALS();
    ssr.runInSSRContext(() => i18n.getLocale());

    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("SSR request isolation is UNAVAILABLE")),
      "AsyncLocalStorage was still available, so this block did not test the fallback",
    ).toBe(true);
    warn.mockRestore();
  });

  it("an async scope ends at the first await, as it always has", async () => {
    // `runInSSRContext` is synchronous: on the fallback path it restores the
    // shared store as soon as `fn()` RETURNS, which for an async function is at
    // its first `await`. That is pre-existing behaviour for the SSR flag and the
    // suspense counter, and the locale now follows exactly the same rule rather
    // than inventing a longer lifetime for itself. It is also why the runtime
    // warns: this is the case where request isolation is unavailable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ssr, i18n } = await loadWithoutALS();
    i18n.registerTranslations("en", { greeting: "Hello" });
    i18n.registerTranslations("es", { greeting: "Hola" });
    i18n.setLocale("en");

    let afterAwait: string | undefined;
    await ssr.runInSSRContext(async () => {
      // Inside the synchronous part the scope is live and owns the locale.
      i18n.setLocale("es");
      expect(i18n.getLocale()).toBe("es");
      await Promise.resolve();
      afterAwait = i18n.getLocale();
      return null;
    });

    // Past the await the scope is gone, so reads fall back to the process
    // default — NOT to another request's locale.
    expect(afterAwait).toBe("en");
    expect(i18n.getLocale()).toBe("en");
    warn.mockRestore();
  });

  it("still scopes the locale to a synchronous render, and restores afterwards", async () => {
    const { ssr, i18n } = await loadWithoutALS();
    i18n.registerTranslations("en", { greeting: "Hello" });
    i18n.registerTranslations("es", { greeting: "Hola" });
    i18n.setLocale("en");

    const rendered = ssr.runInSSRContext(() => {
      i18n.setLocale("es");
      return i18n.t("greeting");
    });

    expect(rendered).toBe("Hola");
    // Save/restore leaves the process default exactly as it was — the fallback
    // must not leak the request's locale either.
    expect(i18n.getLocale()).toBe("en");
    expect(i18n.t("greeting")).toBe("Hello");
  });

  it("restores the outer locale when a nested scope finishes or throws", async () => {
    const { ssr, i18n } = await loadWithoutALS();
    i18n.registerTranslations("en", { greeting: "Hello" });
    i18n.registerTranslations("es", { greeting: "Hola" });
    i18n.registerTranslations("fr", { greeting: "Bonjour" });
    i18n.setLocale("en");

    const seen = ssr.runInSSRContext(() => {
      i18n.setLocale("es");
      const inner = ssr.runInSSRContext(() => {
        i18n.setLocale("fr");
        return i18n.getLocale();
      });
      const afterInner = i18n.getLocale();

      expect(() =>
        ssr.runInSSRContext(() => {
          i18n.setLocale("fr");
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");

      return { inner, afterInner, afterThrow: i18n.getLocale() };
    });

    expect(seen).toEqual({ inner: "fr", afterInner: "es", afterThrow: "es" });
    expect(i18n.getLocale()).toBe("en");
  });

  it("a throwing scope restores the process default", async () => {
    const { ssr, i18n } = await loadWithoutALS();
    i18n.registerTranslations("en", { greeting: "Hello" });
    i18n.setLocale("en");

    expect(() =>
      ssr.runInSSRContext(() => {
        i18n.setLocale("es");
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(i18n.getLocale()).toBe("en");
  });

  it("outside any scope the locale is client-global, as documented", async () => {
    const { ssr, i18n } = await loadWithoutALS();
    i18n.registerTranslations("en", { greeting: "Hello" });
    i18n.registerTranslations("es", { greeting: "Hola" });

    i18n.setLocale("es");
    expect(i18n.getLocale()).toBe("es");
    expect(i18n.t("greeting")).toBe("Hola");

    // And a scope that never selects a locale follows that default rather than
    // hard-coding "en".
    expect(ssr.runInSSRContext(() => i18n.getLocale())).toBe("es");
    i18n.setLocale("en");
  });
});
