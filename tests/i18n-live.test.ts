/**
 * Live i18n: `translated()`, getter parameters, reactive dictionaries.
 *
 * The end-to-end "app shell switches in place" scenarios live in
 * `tests/regressions/i18n-live.test.ts`. This file pins the smaller contracts
 * those scenarios rely on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div, input, span } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { runInSSRContext } from "../src/core/ssr-context";
import {
  getAvailableLocales,
  hasTranslation,
  registerTranslations,
  setLocale,
  Trans,
  t,
  translated,
} from "../src/plugins/i18n";
import { track } from "../src/reactivity/track";

type Registry = Record<symbol, unknown>;
const I18N_KEY = Symbol.for("sibujs.i18n.v1");

beforeEach(() => {
  registerTranslations("en", { "live.hello": "Hello, {name}!", "live.plain": "Plain" });
  registerTranslations("es", { "live.hello": "¡Hola, {name}!", "live.plain": "Sencillo" });
  setLocale("en");
});

afterEach(() => {
  setLocale("en");
});

describe("translated()", () => {
  it("returns a getter that reads the active locale on every call", () => {
    const get = translated("live.plain");
    expect(typeof get).toBe("function");
    expect(get()).toBe("Plain");
    setLocale("es");
    expect(get()).toBe("Sencillo");
  });

  it("updates a text child in place: same parent element, no rebuild", () => {
    const el = span(translated("live.plain")) as HTMLElement;
    const parent = div([el]) as HTMLElement;
    expect(el.textContent).toBe("Plain");

    setLocale("es");
    expect(el.textContent).toBe("Sencillo");
    expect(parent.firstElementChild).toBe(el);
  });

  it("updates an attribute in place without touching the element's value", () => {
    const field = input({
      placeholder: translated("live.plain"),
      "aria-label": translated("live.plain"),
    }) as HTMLInputElement;
    field.value = "typed";

    setLocale("es");
    expect(field.getAttribute("placeholder")).toBe("Sencillo");
    expect(field.getAttribute("aria-label")).toBe("Sencillo");
    expect(field.value).toBe("typed");
  });

  it("tracks getter parameters and the locale together", () => {
    const [name, setName] = signal("Ada");
    const el = span(translated("live.hello", { name })) as HTMLElement;
    expect(el.textContent).toBe("Hello, Ada!");

    setName("Grace");
    expect(el.textContent).toBe("Hello, Grace!");
    setLocale("es");
    expect(el.textContent).toBe("¡Hola, Grace!");
  });
});

describe("parameters", () => {
  it("static values still interpolate", () => {
    expect(t("live.hello", { name: "Fran" })).toBe("Hello, Fran!");
    expect(t("live.hello", { name: 7 })).toBe("Hello, 7!");
  });

  it("getters are resolved at lookup time", () => {
    let calls = 0;
    const params = {
      name: () => {
        calls++;
        return "Lazy";
      },
    };
    expect(calls).toBe(0);
    expect(t("live.hello", params)).toBe("Hello, Lazy!");
    expect(calls).toBe(1);
  });

  it("a placeholder naming an Object.prototype member never reaches the prototype", () => {
    registerTranslations("en", { "live.proto": "[{toString}][{hasOwnProperty}][{constructor}]" });
    // Before getters were called this stringified inherited functions; calling
    // them would now throw (`hasOwnProperty` with no receiver). Neither happens.
    expect(t("live.proto", {})).toBe("[][][]");
  });

  it("a missing parameter renders as empty, as before", () => {
    expect(t("live.hello", {})).toBe("Hello, !");
  });
});

describe("dictionaries are reactive", () => {
  it("a binding re-renders when messages for the active locale arrive later", () => {
    const el = span(translated("live.later")) as HTMLElement;
    const field = input({ title: translated("live.later") }) as HTMLElement;
    setLocale("xx-lazy");
    expect(el.textContent).toBe("live.later");

    registerTranslations("xx-lazy", { "live.later": "Arrived" });
    expect(el.textContent).toBe("Arrived");
    expect(field.getAttribute("title")).toBe("Arrived");
  });

  it("hasTranslation() inside an effect re-runs when the key is registered", () => {
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(hasTranslation("live.flag"));
    });
    registerTranslations("en", { "live.flag": "yes" });
    stop();
    expect(seen).toEqual([false, true]);
  });

  it("getAvailableLocales() inside an effect re-runs when a locale is registered", () => {
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(getAvailableLocales().includes("xx-picker"));
    });
    registerTranslations("xx-picker", { a: "a" });
    stop();
    expect(seen).toEqual([false, true]);
  });

  it("a server render reads the request's locale and does not subscribe to dictionaries", () => {
    // Effects do not run on the server, so the reads are tracked with an
    // explicit subscriber that only counts notifications.
    let serverNotified = 0;
    let clientNotified = 0;
    let rendered = "";
    let stopServer = () => {};
    runInSSRContext(() => {
      setLocale("es");
      stopServer = track(
        () => {
          rendered = t("live.plain");
        },
        () => {
          serverNotified++;
        },
      );
    });
    // Control: the identical read on the client DOES subscribe.
    const stopClient = track(
      () => {
        t("live.plain");
      },
      () => {
        clientNotified++;
      },
    );

    expect(rendered).toBe("Sencillo");
    registerTranslations("es", { "live.other": "Otro" });
    stopServer();
    stopClient();
    expect(clientNotified).toBe(1);
    expect(serverNotified).toBe(0);
  });
});

describe("Trans()", () => {
  it("renders a span that switches with the locale in place", () => {
    const el = Trans("live.plain");
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("Plain");
    setLocale("es");
    expect(el.textContent).toBe("Sencillo");
  });

  it("accepts getter parameters", () => {
    const [name, setName] = signal("Ada");
    const el = Trans("live.hello", { name });
    expect(el.textContent).toBe("Hello, Ada!");
    setName("Lin");
    expect(el.textContent).toBe("Hello, Lin!");
  });
});

describe("an OLDER copy's singleton without a revision signal", () => {
  let saved: unknown;

  beforeEach(() => {
    saved = (globalThis as Registry)[I18N_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete (globalThis as Registry)[I18N_KEY];
    else (globalThis as Registry)[I18N_KEY] = saved;
    vi.resetModules();
  });

  it("is upgraded in place, and two corrected copies share one revision", async () => {
    vi.resetModules();
    const { signal: legacySignal } = await import("../src/core/signals/signal");
    const legacy = { locale: legacySignal("en"), locales: {} as Record<string, Record<string, string>> };
    (globalThis as Registry)[I18N_KEY] = legacy;

    const copyA = await import("../src/plugins/i18n");
    vi.resetModules();
    const copyB = await import("../src/plugins/i18n");

    expect((globalThis as Registry)[I18N_KEY]).toBe(legacy);
    expect("revision" in legacy).toBe(true);

    const el = copyA.Trans("legacy.late");
    copyA.setLocale("xx-legacy");
    expect(el.textContent).toBe("legacy.late");

    // Registered through the OTHER copy — the binding from copy A still hears it.
    copyB.registerTranslations("xx-legacy", { "legacy.late": "Shared" });
    expect(el.textContent).toBe("Shared");
  });
});
