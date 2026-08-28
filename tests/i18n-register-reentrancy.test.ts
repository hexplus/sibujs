/**
 * `registerTranslations()` must survive reentrancy from caller-controlled code.
 *
 * WHAT WAS WRONG
 * --------------
 * The merge read the live dictionary and wrote it back in one expression:
 *
 *     locales[locale] = { ...locales[locale], ...messages };
 *
 * `messages` is caller-controlled, and spreading it runs the caller's property
 * getters and proxy traps. Those can call `registerTranslations()` again — and
 * that nested call commits to `locales[locale]` *after* the outer expression
 * already captured its snapshot of it. The outer write then clobbers the nested
 * one:
 *
 *     register(L, { base: "BASE" })
 *     register(L, { outer: "OUTER", get trigger() { register(L, { nested: … }) } })
 *       → base, outer, trigger present · nested SILENTLY GONE
 *
 * The fix is prepare-then-commit: evaluate every caller-controlled value first,
 * into a plain object with no getters left, and only then read the live
 * dictionary for the merge. By that point no user code can run again.
 *
 * PRECEDENCE, stated deliberately: the outer call's prepared values win over a
 * nested call's for the same key, because the outer call is the one the caller
 * asked for last and its value was computed from what it intended to publish.
 * Nested keys the outer object does not mention survive untouched.
 *
 * Every test uses a unique locale so nothing here depends on, or contaminates,
 * the application-global dictionary other suites share.
 */

import { describe, expect, it } from "vitest";
import { runInSSRContext } from "../src/core/ssr-context";
import { getAvailableLocales, registerTranslations, setLocale, t } from "../src/plugins/i18n";

let counter = 0;
/** A locale nothing else in the suite touches. */
const uniqueLocale = () => `zz-test-${process.pid}-${++counter}`;

/** Read a key under `locale` without disturbing the ambient client locale. */
function read(locale: string, key: string): string {
  const previous = setLocaleAndReturnPrevious(locale);
  try {
    return t(key);
  } finally {
    setLocale(previous);
  }
}

let ambient = "en";
function setLocaleAndReturnPrevious(locale: string): string {
  const previous = ambient;
  ambient = locale;
  setLocale(locale);
  return previous;
}

describe("reentrant registration from a property getter", () => {
  it("1-4. keeps the nested registration, the outer keys and the pre-existing ones", () => {
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

    expect(read(locale, "base"), "a pre-existing key was lost").toBe("BASE");
    expect(read(locale, "outer"), "the outer object's own key was lost").toBe("OUTER");
    expect(read(locale, "trigger"), "the getter's value was lost").toBe("TRIGGER");
    expect(read(locale, "nested"), "the nested registration was erased").toBe("NESTED");
  });

  it("5. the OUTER prepared value wins when both write the same key", () => {
    const locale = uniqueLocale();

    const messages: Record<string, string> = { shared: "OUTER WINS" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations(locale, { shared: "NESTED LOSES", onlyNested: "SURVIVES" });
        return "TRIGGER";
      },
    });

    registerTranslations(locale, messages);

    // Documented precedence: the outer call's own value is what the caller asked
    // to publish last, so it wins…
    expect(read(locale, "shared")).toBe("OUTER WINS");
    // …but a nested key the outer object never mentions is untouched.
    expect(read(locale, "onlyNested")).toBe("SURVIVES");
    expect(read(locale, "trigger")).toBe("TRIGGER");
  });

  it("6-7. a getter registering a DIFFERENT locale leaves both dictionaries intact", () => {
    const outerLocale = uniqueLocale();
    const otherLocale = uniqueLocale();
    registerTranslations(outerLocale, { base: "BASE" });

    const messages: Record<string, string> = { outer: "OUTER" };
    Object.defineProperty(messages, "trigger", {
      enumerable: true,
      get() {
        registerTranslations(otherLocale, { fromGetter: "FROM GETTER" });
        return "TRIGGER";
      },
    });

    registerTranslations(outerLocale, messages);

    expect(read(outerLocale, "base")).toBe("BASE");
    expect(read(outerLocale, "outer")).toBe("OUTER");
    expect(read(outerLocale, "trigger")).toBe("TRIGGER");
    expect(read(otherLocale, "fromGetter")).toBe("FROM GETTER");
    // The other locale did not acquire the outer call's keys.
    expect(read(otherLocale, "outer")).toBe("outer");
  });

  it("several getters each reentering are all preserved", () => {
    const locale = uniqueLocale();
    const messages: Record<string, string> = {};
    for (const n of [1, 2, 3]) {
      Object.defineProperty(messages, `k${n}`, {
        enumerable: true,
        get() {
          registerTranslations(locale, { [`nested${n}`]: `NESTED ${n}` });
          return `VALUE ${n}`;
        },
      });
    }

    registerTranslations(locale, messages);

    for (const n of [1, 2, 3]) {
      expect(read(locale, `k${n}`)).toBe(`VALUE ${n}`);
      expect(read(locale, `nested${n}`), `nested registration ${n} was erased`).toBe(`NESTED ${n}`);
    }
  });
});

describe("reentrant registration from a Proxy trap", () => {
  it("8. a `get` trap that reenters is preserved", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    const target = { outer: "OUTER", trigger: "TRIGGER" };
    const proxied = new Proxy(target, {
      get(t_, key, receiver) {
        if (key === "trigger") registerTranslations(locale, { fromGetTrap: "FROM GET" });
        return Reflect.get(t_, key, receiver);
      },
    });

    registerTranslations(locale, proxied);

    expect(read(locale, "base")).toBe("BASE");
    expect(read(locale, "outer")).toBe("OUTER");
    expect(read(locale, "trigger")).toBe("TRIGGER");
    expect(read(locale, "fromGetTrap"), "a `get` trap's nested registration was erased").toBe("FROM GET");
  });

  it("8b. an `ownKeys` trap that reenters is preserved", () => {
    const locale = uniqueLocale();
    const target = { outer: "OUTER" };
    const proxied = new Proxy(target, {
      ownKeys(t_) {
        registerTranslations(locale, { fromOwnKeys: "FROM OWNKEYS" });
        return Reflect.ownKeys(t_);
      },
    });

    registerTranslations(locale, proxied);

    expect(read(locale, "outer")).toBe("OUTER");
    expect(read(locale, "fromOwnKeys"), "an `ownKeys` trap's nested registration was erased").toBe("FROM OWNKEYS");
  });

  it("8c. a `getOwnPropertyDescriptor` trap that reenters is preserved", () => {
    const locale = uniqueLocale();
    const target = { outer: "OUTER" };
    const proxied = new Proxy(target, {
      getOwnPropertyDescriptor(t_, key) {
        registerTranslations(locale, { fromDescriptor: "FROM DESCRIPTOR" });
        return Reflect.getOwnPropertyDescriptor(t_, key);
      },
    });

    registerTranslations(locale, proxied);

    expect(read(locale, "outer")).toBe("OUTER");
    expect(read(locale, "fromDescriptor")).toBe("FROM DESCRIPTOR");
  });
});

describe("atomicity when caller code throws", () => {
  it("9+12. a getter that throws AFTER a nested registration keeps the nested one", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    const messages: Record<string, string> = { outer: "OUTER" };
    Object.defineProperty(messages, "boom", {
      enumerable: true,
      get() {
        registerTranslations(locale, { nested: "NESTED" });
        throw new Error("getter failed");
      },
    });

    expect(() => registerTranslations(locale, messages)).toThrow("getter failed");

    // The nested call committed on its own and is unaffected by the outer throw.
    expect(read(locale, "nested"), "a completed nested registration was rolled back").toBe("NESTED");
    expect(read(locale, "base")).toBe("BASE");
  });

  it("10-11. a throwing outer call publishes NO partial messages", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { base: "BASE" });

    // `first` is read successfully before `boom` throws. Preparation must have
    // published nothing, so neither key appears.
    const messages: Record<string, string> = {};
    Object.defineProperty(messages, "first", {
      enumerable: true,
      get: () => "FIRST",
    });
    Object.defineProperty(messages, "boom", {
      enumerable: true,
      get() {
        throw new Error("outer failed");
      },
    });

    expect(() => registerTranslations(locale, messages)).toThrow("outer failed");

    expect(read(locale, "first"), "a partially prepared key was published").toBe("first");
    expect(read(locale, "boom")).toBe("boom");
    expect(read(locale, "base"), "the throw damaged the existing dictionary").toBe("BASE");
  });

  it("the dictionary is still usable after a throwing registration", () => {
    const locale = uniqueLocale();
    const messages: Record<string, string> = {};
    Object.defineProperty(messages, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(() => registerTranslations(locale, messages)).toThrow("nope");

    registerTranslations(locale, { after: "AFTER" });
    expect(read(locale, "after")).toBe("AFTER");
  });
});

describe("the prepared snapshot cannot run caller code", () => {
  it("a getter is evaluated exactly ONCE, during preparation", () => {
    // The commit spreads `prepared`, not `messages`. If it spread the caller's
    // object again the getter would run a second time — and could reenter after
    // the dictionary snapshot was taken, which is the defect.
    const locale = uniqueLocale();
    let reads = 0;
    const messages: Record<string, string> = {};
    Object.defineProperty(messages, "counted", {
      enumerable: true,
      get() {
        reads++;
        return "VALUE";
      },
    });

    registerTranslations(locale, messages);

    expect(reads, "the caller's getter ran more than once").toBe(1);
    expect(read(locale, "counted")).toBe("VALUE");
  });

  it("a Proxy trap fires only during preparation", () => {
    const locale = uniqueLocale();
    const trapped: string[] = [];
    const proxied = new Proxy(
      { a: "A" },
      {
        get(t_, key, receiver) {
          trapped.push(String(key));
          return Reflect.get(t_, key, receiver);
        },
      },
    );

    registerTranslations(locale, proxied);
    const before = trapped.length;
    // A later registration for the same locale must not touch the proxy again:
    // the dictionary now holds plain copied data.
    registerTranslations(locale, { b: "B" });

    expect(trapped.length, "the proxy was re-read after preparation").toBe(before);
    expect(read(locale, "a")).toBe("A");
    expect(read(locale, "b")).toBe("B");
  });

  it("copying caller-controlled data does not pollute Object.prototype", () => {
    // Guard rather than a regression: `messages` is caller-controlled, so it is
    // worth proving the copy uses data-property creation and never the
    // `__proto__` setter.
    const locale = uniqueLocale();
    const messages: Record<string, string> = {};
    Object.defineProperty(messages, "__proto__", {
      enumerable: true,
      configurable: true,
      value: "POLLUTED",
      writable: true,
    });
    messages.safe = "SAFE";

    registerTranslations(locale, messages);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("POLLUTED");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(read(locale, "safe")).toBe("SAFE");
  });
});

describe("non-reentrant behaviour is unchanged", () => {
  it("13. successive registrations merge, later values winning", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { a: "A1", b: "B1" });
    registerTranslations(locale, { b: "B2", c: "C1" });

    expect(read(locale, "a")).toBe("A1");
    expect(read(locale, "b")).toBe("B2");
    expect(read(locale, "c")).toBe("C1");
  });

  it("registering an empty object changes nothing", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { a: "A" });
    registerTranslations(locale, {});
    expect(read(locale, "a")).toBe("A");
  });

  it("a new locale appears in getAvailableLocales exactly once", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { a: "A" });
    registerTranslations(locale, { b: "B" });
    expect(getAvailableLocales().filter((l) => l === locale)).toEqual([locale]);
  });

  it("interpolation still works on a merged dictionary", () => {
    const locale = uniqueLocale();
    registerTranslations(locale, { hi: "Hi, {name}!" });
    const previous = setLocaleAndReturnPrevious(locale);
    try {
      expect(t("hi", { name: "Fran" })).toBe("Hi, Fran!");
    } finally {
      setLocale(previous);
    }
  });
});

describe("dictionaries remain application-global", () => {
  it("14. a reentrant registration inside an SSR request is globally visible", async () => {
    const locale = uniqueLocale();

    await runInSSRContext(async () => {
      const messages: Record<string, string> = { outer: "OUTER" };
      Object.defineProperty(messages, "trigger", {
        enumerable: true,
        get() {
          registerTranslations(locale, { nested: "NESTED" });
          return "TRIGGER";
        },
      });
      registerTranslations(locale, messages);
      return null;
    });

    // Registered inside a request, readable outside it — dictionaries are not
    // request-scoped, and reentrancy does not change that.
    expect(read(locale, "outer")).toBe("OUTER");
    expect(read(locale, "nested")).toBe("NESTED");
    expect(read(locale, "trigger")).toBe("TRIGGER");
  });

  it("15. concurrent requests selecting different locales do not disturb dictionaries", async () => {
    const a = uniqueLocale();
    const b = uniqueLocale();
    registerTranslations(a, { greeting: "A GREETING" });
    registerTranslations(b, { greeting: "B GREETING" });

    const [ra, rb] = await Promise.all([
      runInSSRContext(async () => {
        setLocale(a);
        await Promise.resolve();
        return t("greeting");
      }),
      runInSSRContext(async () => {
        setLocale(b);
        await Promise.resolve();
        return t("greeting");
      }),
    ]);

    expect([ra, rb]).toEqual(["A GREETING", "B GREETING"]);
    // Both dictionaries survived, and neither request wrote the other's.
    expect(read(a, "greeting")).toBe("A GREETING");
    expect(read(b, "greeting")).toBe("B GREETING");
  });

  it("a request that registers reentrantly does not leak its locale selection", async () => {
    const locale = uniqueLocale();
    setLocale("en");

    await runInSSRContext(async () => {
      const messages: Record<string, string> = {};
      Object.defineProperty(messages, "k", {
        enumerable: true,
        get() {
          registerTranslations(locale, { nested: "NESTED" });
          return "K";
        },
      });
      registerTranslations(locale, messages);
      setLocale(locale);
      return null;
    });

    // The request chose its own locale; the client default is untouched.
    expect(t("nested")).toBe("nested");
    expect(read(locale, "nested")).toBe("NESTED");
  });
});
