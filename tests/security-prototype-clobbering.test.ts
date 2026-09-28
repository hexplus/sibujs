/**
 * Prototype pollution and DOM clobbering — hostile NAMES rather than hostile
 * values.
 *
 * Each block is a proof-of-concept regression for a confirmed issue, followed
 * by the variant sweep: the same hostile keys (`__proto__`, `constructor`,
 * `prototype`, `toString`, `valueOf`, `hasOwnProperty`, and the DOM names a
 * `<form>` control can shadow) driven through every sibling path that indexes
 * an object or reads DOM state by name.
 */

import { afterEach, describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div, form, input } from "../src/core/rendering/html";
import { applyStructuralSharing, replaceEqualDeep } from "../src/data/structuralSharing";
import { machine } from "../src/patterns/machine";
import { Head } from "../src/platform/head";
import { collectStream, deserializeState, renderToStream, renderToString } from "../src/platform/ssr";
import { createWorkerPool, worker, workerFn } from "../src/platform/worker";
import { deserializeRouteState } from "../src/plugins/routerSSR";
import { preloadCritical } from "../src/plugins/startup";
import { bindAttrs } from "../src/ui/reactiveAttr";

const HOSTILE_KEYS = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"];

afterEach(() => {
  document.body.innerHTML = "";
  for (const el of Array.from(document.head.querySelectorAll("link[rel=preload]"))) el.remove();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

// ─── structural sharing ─────────────────────────────────────────────────────

describe("structural sharing keeps a JSON `__proto__` key as data", () => {
  it("PoC: a refetch cannot turn a payload key into an inherited property", () => {
    const prev = JSON.parse('{"profile":{"name":"a","prefs":{"theme":"dark"}}}');
    const next = JSON.parse('{"profile":{"name":"b","prefs":{"theme":"dark"},"__proto__":{"isAdmin":true}}}');
    const shared = applyStructuralSharing(true, prev, next) as { profile: Record<string, unknown> };
    expect(shared.profile.isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(shared.profile)).toBe(Object.prototype);
    expect(Object.hasOwn(shared.profile, "__proto__")).toBe(true);
    // The shared result still reuses what did not change.
    expect(shared.profile.prefs).toBe(prev.profile.prefs);
  });

  for (const key of HOSTILE_KEYS) {
    it(`"${key}" survives as an own data key through replaceEqualDeep`, () => {
      const prev = JSON.parse(`{"a":{"keep":{"x":1}},"b":1}`);
      const next = JSON.parse(`{"a":{"keep":{"x":1},"${key}":{"polluted":true}},"b":2}`);
      const shared = replaceEqualDeep(prev, next) as { a: Record<string, unknown> };
      expect(Object.hasOwn(shared.a, key)).toBe(true);
      expect((shared.a as Record<string, unknown>).polluted).toBeUndefined();
    });
  }
});

// ─── state machine ──────────────────────────────────────────────────────────

describe("machine only follows transitions the config declares", () => {
  const build = () => {
    let exits = 0;
    const m = machine<"idle" | "busy", "START" | "STOP">({
      initial: "idle",
      states: {
        idle: { on: { START: "busy" }, exit: () => exits++ },
        busy: { on: { STOP: "idle" } },
      },
    });
    return { m, exits: () => exits };
  };

  for (const event of [...HOSTILE_KEYS, "__defineGetter__", "isPrototypeOf"]) {
    it(`PoC: send(${JSON.stringify(event)}) is ignored, not a transition to undefined`, () => {
      const { m, exits } = build();
      m.send(event as never);
      expect(m.state()).toBe("idle");
      expect(exits()).toBe(0);
      expect(m.can(event as never)).toBe(false);
      m.send("START");
      expect(m.state()).toBe("busy");
    });
  }
});

// ─── tag factory and friends under a polluted prototype ─────────────────────

describe("a polluted Object.prototype does not stamp attributes on elements", () => {
  it("tagFactory ignores inherited props, style keys, class keys and handlers", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.formaction = "https://attacker.example/steal";
    proto["aria-label"] = "phish";
    proto.color = "red";
    proto.hidden = true;
    try {
      const el = div({ id: "x", style: { width: "1px" }, class: { a: true } });
      expect(el.hasAttribute("formaction")).toBe(false);
      expect(el.hasAttribute("aria-label")).toBe(false);
      expect(el.hasAttribute("hidden")).toBe(false);
      expect(el.getAttribute("style")).toBe("width: 1px;");
      expect(el.getAttribute("class")).toBe("a");
      const tpl = html`<div class=${"k"}></div>`;
      expect(tpl.hasAttribute("formaction")).toBe(false);
    } finally {
      delete proto.formaction;
      delete proto["aria-label"];
      delete proto.color;
      delete proto.hidden;
    }
  });

  for (const key of HOSTILE_KEYS) {
    it(`an own "${key}" key in attribute / style / Head maps never reaches a prototype`, () => {
      const attrs = JSON.parse(`{"${key}":"x","title":"t"}`);
      const el = document.createElement("div");
      bindAttrs(el, attrs);
      div(attrs);
      div({ style: JSON.parse(`{"${key}":"red"}`) });
      div({ class: JSON.parse(`{"${key}":true}`) });
      Head({ meta: [JSON.parse(`{"${key}":"x","name":"n","content":"c"}`)] });
      expect(({} as Record<string, unknown>).x).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });
  }
});

// ─── DOM clobbering: framework globals ──────────────────────────────────────

describe("SSR state globals cannot be clobbered by rendered markup", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__;
    delete (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__;
  });

  it("PoC: an element with id=__SIBU_SSR_DATA__ is not returned as state", () => {
    document.body.innerHTML = '<form id="__SIBU_SSR_DATA__"><input name="isAdmin" value="1"></form>';
    expect(deserializeState((d): d is Record<string, unknown> => typeof d === "object" && d !== null)).toBeUndefined();
  });

  it("PoC: an element with id=__SIBU_ROUTE_STATE__ is not returned as route state", () => {
    document.body.innerHTML = '<div id="__SIBU_ROUTE_STATE__"></div>';
    expect(deserializeRouteState()).toBeUndefined();
  });

  it("the real, script-assigned state is still read", () => {
    document.body.innerHTML = '<div id="__SIBU_SSR_DATA__"></div>';
    (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__ = { ok: true };
    expect(deserializeState((d): d is { ok: boolean } => typeof d === "object" && d !== null)).toEqual({ ok: true });
  });
});

// ─── DOM clobbering: the SSR serializer ─────────────────────────────────────

/**
 * Simulate `<input name="…">` shadowing a `<form>`'s own API. Browsers do this
 * natively ([LegacyOverrideBuiltIns]); jsdom does not implement form named
 * properties, so the same shadowing is installed as an own property — which is
 * exactly what a named property is from the serializer's point of view.
 */
function clobber(target: Element, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, get: () => value });
}

describe("the SSR serializer reads DOM state through native accessors", () => {
  for (const name of ["attributes", "childNodes", "tagName", "dataset", "getAttribute"]) {
    it(`PoC: a form control named "${name}" does not change the server HTML`, async () => {
      const build = () => form({ method: "post", action: "/login" }, [input({ name: "password", type: "password" })]);
      const clean = renderToString(build());
      const target = build();
      clobber(target, name, input({ name }));
      expect(renderToString(target)).toBe(clean);
      expect(await collectStream(renderToStream(target))).toBe(clean);
      expect(clean).toContain('method="post"');
      expect(clean).toContain('action="/login"');
    });
  }
});

// ─── eval-equivalent APIs demand an explicit decision ───────────────────────

describe("worker helpers refuse anything but a function", () => {
  for (const [label, create] of [
    ["worker", (code: unknown) => worker(code as never)],
    ["workerFn", (code: unknown) => workerFn(code as never)],
    ["createWorkerPool", (code: unknown) => createWorkerPool(code as never, 1)],
  ] as const) {
    it(`PoC: ${label}(string) throws instead of evaluating it`, () => {
      expect(() => create("fetch('/api/me').then((r) => r.text()).then(postMessage)")).toThrow(TypeError);
      expect(() => create({ toString: () => "postMessage(1)" })).toThrow(TypeError);
    });
  }
});

describe("preloadCritical applies the shared URL allowlist", () => {
  it("skips a dangerous href and keeps a safe one", () => {
    preloadCritical([
      { href: "javascript:alert(1)", as: "script" },
      { href: "data:text/javascript,alert(1)", as: "script" },
      { href: "/assets/app.js", as: "script" },
    ]);
    const hrefs = Array.from(document.head.querySelectorAll("link[rel=preload]")).map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/assets/app.js"]);
  });
});
