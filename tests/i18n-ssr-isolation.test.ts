/**
 * i18n locale ownership across concurrent SSR requests.
 *
 * WHAT WAS WRONG
 * --------------
 * The active locale lived in a process-global signal:
 *
 *     const _i18n = globalSingleton(Symbol.for("sibujs.i18n.v1"), () => ({
 *       locale: signal("en"),
 *       locales: {} as LocaleMap,
 *     }));
 *
 * That is exactly right for the browser — one page, one active locale, shared
 * across duplicated bundle copies — and exactly wrong on a server, where every
 * concurrent request has its own. Two overlapping renders therefore overwrote
 * each other:
 *
 *     A enters its request context, sets "en", awaits
 *     B enters its own context, sets "es", renders, finishes
 *     A resumes and renders  →  Spanish, because B moved the global signal
 *
 * The framework already carries an `AsyncLocalStorage`-backed per-request store
 * (`core/ssr-context.ts`); i18n simply was not participating in it.
 *
 * WHAT THESE TESTS ASSERT
 * -----------------------
 * Ordering is forced with explicit deferred barriers, never sleeps, so the
 * interleaving above is guaranteed rather than hoped for. Every assertion goes
 * through the PUBLIC api — `setLocale`, `getLocale`, `t`, `hasTranslation`,
 * `Trans` — because that is what an application observes; asserting the store
 * directly would pass even if the public functions still read the global.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSSRStore, runInSSRContext } from "../src/core/ssr-context";
import { getLocale, hasTranslation, registerTranslations, setLocale, Trans, t } from "../src/plugins/i18n";
import { createDeferred, type Deferred } from "./helpers/mocks";

function gate<T = void>(): Deferred<T> {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

beforeEach(() => {
  registerTranslations("en", { greeting: "Hello", only_en: "English only" });
  registerTranslations("es", { greeting: "Hola" });
  registerTranslations("fr", { greeting: "Bonjour" });
  // Re-establish the process default so a previous test cannot influence this one.
  setLocale("en");
});

afterEach(() => {
  setLocale("en");
});

// ─── the mandated reproduction ──────────────────────────────────────────────

describe("concurrent SSR requests own their locale", () => {
  it("A does not observe B's locale across an await barrier", async () => {
    const aReachedBarrier = gate<void>();
    const bFinished = gate<void>();
    const observed: Record<string, string> = {};

    const requestA = runInSSRContext(async () => {
      setLocale("en");
      aReachedBarrier.resolve();
      // A pauses here, INSIDE its request, while B runs start to finish.
      await bFinished.promise;
      observed.aLocale = getLocale();
      observed.aGreeting = t("greeting");
      return t("greeting");
    });

    await aReachedBarrier.promise;

    const requestB = runInSSRContext(async () => {
      setLocale("es");
      observed.bLocale = getLocale();
      observed.bGreeting = t("greeting");
      return t("greeting");
    });

    const bResult = await requestB;
    bFinished.resolve();
    const aResult = await requestA;

    expect(bResult).toBe("Hola");
    expect(aResult, "request A rendered request B's locale").toBe("Hello");
    expect(observed).toEqual({
      aLocale: "en",
      aGreeting: "Hello",
      bLocale: "es",
      bGreeting: "Hola",
    });
  });

  it("requests settling in invocation order stay isolated", async () => {
    const bStarted = gate<void>();
    const aDone = gate<void>();

    const a = runInSSRContext(async () => {
      setLocale("en");
      await bStarted.promise;
      const value = t("greeting");
      aDone.resolve();
      return value;
    });

    const b = runInSSRContext(async () => {
      setLocale("es");
      bStarted.resolve();
      await aDone.promise;
      return t("greeting");
    });

    expect(await a).toBe("Hello");
    expect(await b).toBe("Hola");
  });

  it("requests settling in reverse order stay isolated", async () => {
    const aReady = gate<void>();
    const bDone = gate<void>();

    const a = runInSSRContext(async () => {
      setLocale("en");
      aReady.resolve();
      await bDone.promise;
      return t("greeting");
    });

    await aReady.promise;

    const b = runInSSRContext(async () => {
      setLocale("es");
      return t("greeting");
    });

    expect(await b).toBe("Hola");
    bDone.resolve();
    expect(await a).toBe("Hello");
  });

  it("a request keeps its locale across MULTIPLE await boundaries", async () => {
    const barriers = [gate<void>(), gate<void>(), gate<void>()];
    const seen: string[] = [];

    const a = runInSSRContext(async () => {
      setLocale("en");
      for (const barrier of barriers) {
        await barrier.promise;
        seen.push(getLocale());
      }
      return t("greeting");
    });

    // Between every one of A's resumptions, a different request changes locale.
    for (const [index, barrier] of barriers.entries()) {
      await runInSSRContext(async () => {
        setLocale(index % 2 === 0 ? "es" : "fr");
        return t("greeting");
      });
      barrier.resolve();
      await Promise.resolve();
    }

    expect(await a).toBe("Hello");
    expect(seen).toEqual(["en", "en", "en"]);
  });

  it("three concurrent requests use three different locales", async () => {
    const release = gate<void>();
    const start = [gate<void>(), gate<void>(), gate<void>()];

    const make = (locale: string, index: number) =>
      runInSSRContext(async () => {
        setLocale(locale);
        start[index].resolve();
        await release.promise;
        return `${getLocale()}:${t("greeting")}`;
      });

    const en = make("en", 0);
    const es = make("es", 1);
    const fr = make("fr", 2);

    // Every request has set its locale before any of them resumes.
    await Promise.all(start.map((g) => g.promise));
    release.resolve();

    expect(await Promise.all([en, es, fr])).toEqual(["en:Hello", "es:Hola", "fr:Bonjour"]);
  });
});

// ─── failure and cleanup ────────────────────────────────────────────────────

describe("a failing request leaks nothing", () => {
  it("a synchronous throw does not leak the locale", () => {
    expect(() =>
      runInSSRContext(() => {
        setLocale("es");
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(getLocale(), "the global locale was overwritten by a request").toBe("en");
    expect(t("greeting")).toBe("Hello");
  });

  it("an asynchronous rejection does not leak the locale", async () => {
    const failing = runInSSRContext(async () => {
      setLocale("fr");
      await Promise.resolve();
      throw new Error("render rejected");
    });

    await expect(failing).rejects.toThrow("render rejected");
    expect(getLocale()).toBe("en");
  });

  it("a request after a failed one does not inherit its locale", async () => {
    await expect(
      runInSSRContext(async () => {
        setLocale("fr");
        throw new Error("A failed");
      }),
    ).rejects.toThrow("A failed");

    const inherited = await runInSSRContext(async () => getLocale());
    expect(inherited, "a later request inherited a failed request's locale").toBe("en");
  });

  it("the global locale is unchanged after a SUCCESSFUL request", async () => {
    expect(getLocale()).toBe("en");
    const result = await runInSSRContext(async () => {
      setLocale("es");
      return t("greeting");
    });
    expect(result).toBe("Hola");
    expect(getLocale(), "an SSR request mutated the global locale").toBe("en");
    expect(t("greeting")).toBe("Hello");
  });

  it("the global locale is unchanged after a FAILED request", async () => {
    await expect(
      runInSSRContext(async () => {
        setLocale("es");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getLocale()).toBe("en");
  });

  it("a request-scoped locale does not survive into the store afterwards", async () => {
    await runInSSRContext(async () => {
      setLocale("es");
      return null;
    });
    // The fallback/global store must carry no request locale once the request
    // has settled — otherwise the next caller outside a request would read it.
    expect(getSSRStore().locale).toBeUndefined();
    expect(getLocale()).toBe("en");
  });
});

// ─── nested contexts ────────────────────────────────────────────────────────

describe("nested SSR contexts restore the outer locale", () => {
  it("inner context observes its own locale, outer is restored", async () => {
    const seen: Record<string, string> = {};

    await runInSSRContext(async () => {
      setLocale("en");
      seen.outerBefore = getLocale();

      await runInSSRContext(async () => {
        setLocale("es");
        seen.inner = getLocale();
        seen.innerGreeting = t("greeting");
        return null;
      });

      seen.outerAfter = getLocale();
      seen.outerGreeting = t("greeting");
      return null;
    });

    expect(seen).toEqual({
      outerBefore: "en",
      inner: "es",
      innerGreeting: "Hola",
      outerAfter: "en",
      outerGreeting: "Hello",
    });
    expect(getLocale()).toBe("en");
  });

  it("an inner context that THROWS still restores the outer locale", async () => {
    const seen: Record<string, string> = {};

    await runInSSRContext(async () => {
      setLocale("en");
      expect(() =>
        runInSSRContext(() => {
          setLocale("fr");
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");

      seen.outerAfter = getLocale();
      seen.outerGreeting = t("greeting");
      return null;
    });

    expect(seen).toEqual({ outerAfter: "en", outerGreeting: "Hello" });
    expect(getLocale()).toBe("en");
  });

  it("an inner context that REJECTS still restores the outer locale", async () => {
    const seen: Record<string, string> = {};

    await runInSSRContext(async () => {
      setLocale("en");
      await expect(
        runInSSRContext(async () => {
          setLocale("fr");
          throw new Error("inner rejected");
        }),
      ).rejects.toThrow("inner rejected");

      seen.outerAfter = getLocale();
      return null;
    });

    expect(seen).toEqual({ outerAfter: "en" });
    expect(getLocale()).toBe("en");
  });

  it("an inner context that never sets a locale does not disturb the outer one", async () => {
    const seen: Record<string, string> = {};
    await runInSSRContext(async () => {
      setLocale("es");
      await runInSSRContext(async () => {
        seen.innerDefault = getLocale();
        return null;
      });
      seen.outerAfter = getLocale();
      return null;
    });
    // The inner request never chose a locale, so it uses the process default —
    // NOT the outer request's, which belongs to a different request scope.
    expect(seen).toEqual({ innerDefault: "en", outerAfter: "es" });
  });
});

// ─── public API consistency ─────────────────────────────────────────────────

describe("every public entry point resolves the request locale", () => {
  it("setLocale and getLocale agree inside each request", async () => {
    const results = await Promise.all(
      ["en", "es", "fr"].map((locale) =>
        runInSSRContext(async () => {
          setLocale(locale);
          await Promise.resolve();
          return getLocale();
        }),
      ),
    );
    expect(results).toEqual(["en", "es", "fr"]);
  });

  it("t() resolves using the request locale", async () => {
    const [a, b] = await Promise.all([
      runInSSRContext(async () => {
        setLocale("es");
        await Promise.resolve();
        return t("greeting");
      }),
      runInSSRContext(async () => {
        setLocale("fr");
        await Promise.resolve();
        return t("greeting");
      }),
    ]);
    expect([a, b]).toEqual(["Hola", "Bonjour"]);
  });

  it("t() interpolates parameters using the request locale", async () => {
    registerTranslations("en", { welcome: "Welcome, {name}!" });
    registerTranslations("es", { welcome: "Bienvenido, {name}!" });

    const [a, b] = await Promise.all([
      runInSSRContext(async () => {
        setLocale("en");
        await Promise.resolve();
        return t("welcome", { name: "Fran" });
      }),
      runInSSRContext(async () => {
        setLocale("es");
        await Promise.resolve();
        return t("welcome", { name: "Fran" });
      }),
    ]);
    expect([a, b]).toEqual(["Welcome, Fran!", "Bienvenido, Fran!"]);
  });

  it("hasTranslation() resolves using the request locale", async () => {
    const [a, b] = await Promise.all([
      runInSSRContext(async () => {
        setLocale("en");
        await Promise.resolve();
        return hasTranslation("only_en");
      }),
      runInSSRContext(async () => {
        setLocale("es");
        await Promise.resolve();
        return hasTranslation("only_en");
      }),
    ]);
    expect([a, b]).toEqual([true, false]);
  });

  it("Trans() renders the request locale", async () => {
    const [a, b] = await Promise.all([
      runInSSRContext(async () => {
        setLocale("es");
        await Promise.resolve();
        return Trans("greeting").textContent;
      }),
      runInSSRContext(async () => {
        setLocale("fr");
        await Promise.resolve();
        return Trans("greeting").textContent;
      }),
    ]);
    expect([a, b]).toEqual(["Hola", "Bonjour"]);
  });

  it("a request that never calls setLocale uses the process default", async () => {
    const inherited = await runInSSRContext(async () => `${getLocale()}:${t("greeting")}`);
    expect(inherited).toBe("en:Hello");

    // …and follows the process default when the application changes it at
    // startup, rather than hard-coding "en".
    setLocale("fr");
    const followed = await runInSSRContext(async () => `${getLocale()}:${t("greeting")}`);
    expect(followed).toBe("fr:Bonjour");
    setLocale("en");
  });

  it("outside SSR the locale remains reactive", async () => {
    const { effect } = await import("../src/core/signals/effect");
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(t("greeting"));
    });

    setLocale("es");
    setLocale("fr");
    stop();
    setLocale("en");

    expect(seen, "client locale switching stopped being reactive").toEqual(["Hello", "Hola", "Bonjour"]);
  });

  it("Trans() stays REACTIVE on the client", async () => {
    // Review question: did routing the locale through the request store break
    // the client binding? `Trans` renders `span(() => t(key))`, so it must still
    // re-render when the client locale changes. The pre-existing Trans test only
    // asserts the tag name, so this is the first assertion that the text
    // actually tracks the locale.
    setLocale("en");
    const el = Trans("greeting");
    expect(el.textContent).toBe("Hello");

    setLocale("es");
    expect(el.textContent, "Trans stopped tracking the client locale").toBe("Hola");

    setLocale("fr");
    expect(el.textContent).toBe("Bonjour");
    setLocale("en");
    expect(el.textContent).toBe("Hello");
  });

  it("a client Trans() binding is not disturbed by a concurrent SSR request", async () => {
    setLocale("en");
    const el = Trans("greeting");
    expect(el.textContent).toBe("Hello");

    await runInSSRContext(async () => {
      setLocale("es");
      await Promise.resolve();
      return null;
    });

    // The request chose Spanish for itself; the live client binding is untouched.
    expect(el.textContent).toBe("Hello");
  });

  it("an SSR request does not disturb a client subscriber", async () => {
    const { effect } = await import("../src/core/signals/effect");
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(getLocale());
    });

    await runInSSRContext(async () => {
      setLocale("es");
      return null;
    });

    stop();
    // The subscriber ran once, for its initial read, and never again: no SSR
    // request wrote to the signal it is watching.
    expect(seen).toEqual(["en"]);
  });
});

// ─── translation registry ownership ─────────────────────────────────────────

describe("translation dictionaries are application-global", () => {
  it("globally registered translations are readable from separate requests", async () => {
    registerTranslations("de", { greeting: "Hallo" });
    const results = await Promise.all(
      ["de", "es"].map((locale) =>
        runInSSRContext(async () => {
          setLocale(locale);
          await Promise.resolve();
          return t("greeting");
        }),
      ),
    );
    expect(results).toEqual(["Hallo", "Hola"]);
  });

  it("concurrent locale selection neither duplicates nor erases dictionaries", async () => {
    const { getAvailableLocales } = await import("../src/plugins/i18n");
    const before = [...getAvailableLocales()].sort();

    await Promise.all(
      ["en", "es", "fr"].map((locale) =>
        runInSSRContext(async () => {
          setLocale(locale);
          await Promise.resolve();
          return t("greeting");
        }),
      ),
    );

    expect([...getAvailableLocales()].sort()).toEqual(before);
    expect(t("greeting")).toBe("Hello");
  });

  it("registering more messages preserves the ones already registered", () => {
    registerTranslations("en", { first: "First" });
    registerTranslations("en", { second: "Second" });
    setLocale("en");
    expect(t("first")).toBe("First");
    expect(t("second")).toBe("Second");
    expect(t("greeting")).toBe("Hello");
  });

  it("registration DURING a request is application-global and visible everywhere", async () => {
    // Registration is deliberately not request-scoped: dictionaries are static
    // application data, and copying them per request would duplicate every
    // message for no benefit. This pins that contract — a message registered
    // inside one request is visible to another, and to the client.
    const registered = gate<void>();

    const writer = runInSSRContext(async () => {
      registerTranslations("es", { runtime_key: "Registrado" });
      registered.resolve();
      return null;
    });

    await registered.promise;
    await writer;

    const reader = await runInSSRContext(async () => {
      setLocale("es");
      await Promise.resolve();
      return t("runtime_key");
    });

    expect(reader).toBe("Registrado");
    setLocale("es");
    expect(t("runtime_key")).toBe("Registrado");
    setLocale("en");
  });

  it("concurrent registration of different locales does not corrupt either", async () => {
    await Promise.all([
      runInSSRContext(async () => {
        registerTranslations("it", { greeting: "Ciao" });
        await Promise.resolve();
        registerTranslations("it", { extra: "Extra IT" });
        return null;
      }),
      runInSSRContext(async () => {
        registerTranslations("pt", { greeting: "Ola" });
        await Promise.resolve();
        registerTranslations("pt", { extra: "Extra PT" });
        return null;
      }),
    ]);

    const [it, pt] = await Promise.all([
      runInSSRContext(async () => {
        setLocale("it");
        await Promise.resolve();
        return `${t("greeting")}/${t("extra")}`;
      }),
      runInSSRContext(async () => {
        setLocale("pt");
        await Promise.resolve();
        return `${t("greeting")}/${t("extra")}`;
      }),
    ]);

    expect([it, pt]).toEqual(["Ciao/Extra IT", "Ola/Extra PT"]);
  });
});

// ─── retention ──────────────────────────────────────────────────────────────

describe("request locale records do not accumulate", () => {
  it("repeated request cycles leave no residue", async () => {
    for (let i = 0; i < 200; i++) {
      const locale = ["en", "es", "fr"][i % 3];
      const rendered = await runInSSRContext(async () => {
        setLocale(locale);
        await Promise.resolve();
        return t("greeting");
      });
      expect(rendered).toBe({ en: "Hello", es: "Hola", fr: "Bonjour" }[locale]);
    }

    // Nothing outside the requests changed, and the shared store holds no
    // request locale: the only place a locale was written is each request's own
    // store, which AsyncLocalStorage discards with the request.
    expect(getSSRStore().locale).toBeUndefined();
    expect(getLocale()).toBe("en");
  });

  it("no unhandled rejection escapes a failing request", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        runInSSRContext(async () => {
          setLocale("es");
          throw new Error("failed");
        }),
      ).rejects.toThrow("failed");
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ─── adversarial review cases ───────────────────────────────────────────────

describe("the isolation is real, not accidental serialization", () => {
  it("records an interleaving in which B ran entirely inside A's request", async () => {
    // A test that merely runs two requests back to back would pass even with the
    // process-global signal. This one logs the actual order and asserts that B
    // started AND finished between A's two halves — so the interleaving that
    // caused the defect is proven to have happened.
    const trace: string[] = [];
    const aPaused = gate<void>();
    const bDone = gate<void>();

    const a = runInSSRContext(async () => {
      trace.push("A:start");
      setLocale("en");
      aPaused.resolve();
      await bDone.promise;
      trace.push("A:resume");
      const rendered = t("greeting");
      trace.push(`A:render=${rendered}`);
      return rendered;
    });

    await aPaused.promise;

    const b = runInSSRContext(async () => {
      trace.push("B:start");
      setLocale("es");
      const rendered = t("greeting");
      trace.push(`B:render=${rendered}`);
      return rendered;
    });

    await b;
    bDone.resolve();
    await a;

    expect(trace).toEqual(["A:start", "B:start", "B:render=Hola", "A:resume", "A:render=Hello"]);
  });
});

describe("scopes that are not request scopes keep client behaviour", () => {
  it("withSSR() does not create a request scope", async () => {
    const { withSSR } = await import("../src/core/ssr-context");
    withSSR(() => {
      // `withSSR` flips the SSR flag on whatever store is current; it does not
      // establish a request. The locale therefore stays client-global, which is
      // the pre-existing behaviour.
      setLocale("es");
      expect(getLocale()).toBe("es");
    });
    expect(getLocale(), "withSSR should not have isolated the locale").toBe("es");
    setLocale("en");
  });

  it("enableSSR()/disableSSR() outside a context keep the client locale", async () => {
    const { enableSSR, disableSSR } = await import("../src/core/ssr-context");
    enableSSR();
    try {
      setLocale("fr");
      expect(getLocale()).toBe("fr");
    } finally {
      disableSSR();
    }
    // Still the client locale: no request store was ever created.
    expect(getLocale()).toBe("fr");
    setLocale("en");
  });

  it("rendering without a request context uses the client locale", () => {
    setLocale("es");
    expect(t("greeting")).toBe("Hola");
    setLocale("en");
    expect(t("greeting")).toBe("Hello");
  });
});
