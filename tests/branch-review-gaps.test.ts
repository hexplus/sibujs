import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipe } from "../src/browser/swipe";
import { urlState } from "../src/browser/urlState";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { dispose, registerDisposer, withDisposerRollback } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { defineElement } from "../src/platform/customElement";
import { Head } from "../src/platform/head";
import { createISR } from "../src/platform/incrementalRegeneration";
import { renderToDocument } from "../src/platform/ssr";
import { createPluginRegistry } from "../src/plugins/plugin";
import { createMigrationRunner } from "../src/plugins/versioning";
import { checkFormLabels, checkKeyboardAccess } from "../src/testing/a11y";
import { createHttpMock } from "../src/testing/e2e";
import { hotkey } from "../src/ui/a11y";
import { TransitionGroup } from "../src/ui/TransitionGroup";
import { tooltip } from "../src/widgets/Tooltip";

let handler: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

let elementId = 0;
const uniqueTag = () => `x-branch-review-${++elementId}`;

// ---------------------------------------------------------------------------
// customElement: self-written attributes, bounded feedback, retry after failure.
// ---------------------------------------------------------------------------
describe("defineElement render reentrancy", () => {
  it("a component mirroring state onto an observed host attribute renders once per change", () => {
    const tag = uniqueTag();
    const renders = vi.fn();
    defineElement(
      tag,
      (props, host) => {
        renders();
        host.setAttribute("state", props.open ? "open" : "closed");
        return div(String(props.open ?? "")) as HTMLElement;
      },
      { observedAttributes: ["open", "state"] },
    );
    const el = document.createElement(tag);
    document.body.appendChild(el);
    const initial = renders.mock.calls.length;

    el.setAttribute("open", "1");
    // One render for the change, plus at most one follow-up for the mirrored value.
    expect(renders.mock.calls.length - initial).toBeLessThanOrEqual(2);
    expect(el.getAttribute("state")).toBe("open");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a component that changes its own attribute on every render is stopped and reported", () => {
    const tag = uniqueTag();
    let n = 0;
    const renders = vi.fn();
    defineElement(
      tag,
      (_props, host) => {
        renders();
        host.setAttribute("tick", String(++n));
        return div() as HTMLElement;
      },
      { observedAttributes: ["tick"] },
    );
    const el = document.createElement(tag);
    expect(() => document.body.appendChild(el)).not.toThrow();
    expect(renders.mock.calls.length).toBeLessThanOrEqual(10);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "render" });
  });

  it("a failed first render is retried when an attribute changes", () => {
    const tag = uniqueTag();
    defineElement(
      tag,
      (props) => {
        if (props.bad !== undefined) throw new Error("bad input");
        return div("ok") as HTMLElement;
      },
      { observedAttributes: ["bad"], shadow: false },
    );
    const el = document.createElement(tag);
    el.setAttribute("bad", "");
    document.body.appendChild(el);
    expect(el.textContent).toBe("");
    expect(handler).toHaveBeenCalledTimes(1);

    el.removeAttribute("bad");
    expect(el.textContent).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Rollback ignores registrations made by unrelated reactive re-runs.
// ---------------------------------------------------------------------------
describe("withDisposerRollback scope", () => {
  it("a failed render does not tear down bindings an effect re-registered on live DOM", () => {
    const live = document.createElement("div");
    document.body.appendChild(live);
    const [s, set] = signal(0);
    const torn = vi.fn();
    const stop = effect(() => {
      if (s() > 0) registerDisposer(live, torn);
    });

    expect(() =>
      withDisposerRollback(() => {
        set(1);
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(torn).not.toHaveBeenCalled();
    dispose(live);
    expect(torn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("registrations made directly by the build are still rolled back", () => {
    const node = document.createElement("div");
    const own = vi.fn();
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, own);
        throw new Error("render failed");
      }),
    ).toThrow();
    expect(own).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Plugins can register after install() returns.
// ---------------------------------------------------------------------------
describe("plugin context after commit", () => {
  it("hooks and providers registered after install() reach the live registry", () => {
    const registry = createPluginRegistry();
    let saved: Parameters<Parameters<typeof registry.plugin>[0]["install"]>[0] | undefined;
    const lateInit = vi.fn();
    registry.plugin({
      name: "late",
      install(ctx) {
        saved = ctx;
        ctx.onInit(() => {
          ctx.provide("k", 1);
          ctx.onInit(lateInit);
        });
      },
    });
    expect(registry.inject("k")).toBe(1);
    // An init hook registered by an init hook is recorded, not run in the same loop.
    expect(lateInit).not.toHaveBeenCalled();
    expect(registry.hooks.init).toContain(lateInit);

    const mount = vi.fn();
    saved?.onMount(mount);
    registry.triggerMount(document.createElement("div"));
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("a throwing install still commits nothing", () => {
    const registry = createPluginRegistry();
    expect(() =>
      registry.plugin({
        name: "broken",
        install(ctx) {
          ctx.provide("x", 1);
          throw new Error("install failed");
        },
      }),
    ).toThrow();
    expect(registry.provided.has("x")).toBe(false);
    expect(registry.installedPlugins.has("broken")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISR keeps retrying after a failed revalidation.
// ---------------------------------------------------------------------------
describe("createISR retry after failure", () => {
  it("a transient fetch failure is retried after revalidateAfter", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const isr = createISR({
      revalidateAfter: 100,
      initialData: 1,
      fetcher: async () => {
        calls++;
        if (calls === 1) throw new Error("network");
        return 2;
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    expect(isr.isStale()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    expect(isr.data()).toBe(2);
    expect(isr.isStale()).toBe(false);
    isr.dispose();
  });
});

// ---------------------------------------------------------------------------
// hotkey: the "+" key.
// ---------------------------------------------------------------------------
describe("hotkey plus key", () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));

  it('"+" and "ctrl++" register and fire', () => {
    const plain = vi.fn();
    const withCtrl = vi.fn();
    const stopPlain = hotkey("+", plain);
    const stopCtrl = hotkey("ctrl++", withCtrl);
    press("+");
    press("+", { ctrlKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(withCtrl).toHaveBeenCalledTimes(1);
    stopPlain();
    stopCtrl();
  });

  it("a combo with no key still throws", () => {
    expect(() => hotkey("ctrl+", () => {})).toThrow(/missing key/);
    expect(() => hotkey("hyper+s", () => {})).toThrow(/unknown modifier/);
  });
});

// ---------------------------------------------------------------------------
// TransitionGroup.remove isolates leave failures.
// ---------------------------------------------------------------------------
describe("TransitionGroup.remove failures", () => {
  it("a throwing leave is reported, the element is removed, and remove() resolves", async () => {
    const el = document.createElement("div");
    const leave = vi.fn(() => {
      throw new Error("leave failed");
    });
    const group = TransitionGroup({ leave });
    group.add(el);
    await expect(group.remove(el)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ node: el });

    // No longer tracked, so a later track() does not call leave for it again.
    group.track([]);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("a rejecting leave behaves the same", async () => {
    const el = document.createElement("div");
    const group = TransitionGroup({ leave: async () => Promise.reject(new Error("async leave")) });
    group.add(el);
    await expect(group.remove(el)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// a11y: delegated listeners and labels outside the checked root.
// ---------------------------------------------------------------------------
describe("a11y false positives", () => {
  it("a container delegating clicks to real buttons is not a violation", () => {
    const list = document.createElement("ul");
    for (let i = 0; i < 2; i++) {
      const li = document.createElement("li");
      li.appendChild(document.createElement("button")).textContent = `b${i}`;
      list.appendChild(li);
    }
    list.addEventListener("click", () => {});
    expect(checkKeyboardAccess(list)).toEqual([]);
  });

  it("a clickable container with no keyboard-reachable content is still reported", () => {
    const box = document.createElement("div");
    box.textContent = "click me";
    box.addEventListener("click", () => {});
    expect(checkKeyboardAccess(box).some((v) => v.level === "error")).toBe(true);
  });

  it("checking an input directly sees its <label for> elsewhere in the document", () => {
    document.body.innerHTML = '<label for="name-field">Name</label><input id="name-field">';
    const input = document.getElementById("name-field") as HTMLElement;
    expect(checkFormLabels(input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createHttpMock: jsdom structured bodies and abort reasons.
// ---------------------------------------------------------------------------
describe("createHttpMock in jsdom", () => {
  it("passes jsdom FormData and URLSearchParams through with a matching content type", async () => {
    const seen: Array<{ body: unknown; type: string | null }> = [];
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/x",
        response: ({ body, headers }) => {
          seen.push({ body, type: headers.get("content-type") });
          return { body: "ok" };
        },
      },
    ]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const form = new FormData();
      form.append("name", "Ada");
      await fetch("/x", { method: "POST", body: form });
      await fetch("/x", { method: "POST", body: new URLSearchParams("a=1") });
      await fetch("/x", { method: "POST", body: "plain" });
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
    expect(seen[0].body).toBeInstanceOf(FormData);
    expect((seen[0].body as FormData).get("name")).toBe("Ada");
    expect(seen[0].type).toMatch(/^multipart\/form-data/);
    expect(seen[1].body).toBeInstanceOf(URLSearchParams);
    expect(seen[1].type).toMatch(/^application\/x-www-form-urlencoded/);
    expect(seen[2]).toEqual({ body: "plain", type: "text/plain;charset=UTF-8" });
  });

  it("rejects with the signal's reason, like fetch()", async () => {
    const mock = createHttpMock([{ url: "/slow", response: { delay: 1000, body: "late" } }]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const timeout = new AbortController();
      const pending = fetch("/slow", { signal: timeout.signal });
      const reason = new DOMException("took too long", "TimeoutError");
      timeout.abort(reason);
      await expect(pending).rejects.toBe(reason);

      const custom = new AbortController();
      const pending2 = fetch("/slow", { signal: custom.signal });
      custom.abort("user cancelled");
      await expect(pending2).rejects.toBe("user cancelled");
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// swipe: missed touchend and fingers elsewhere.
// ---------------------------------------------------------------------------
describe("swipe gesture recovery", () => {
  type T = { identifier: number; clientX: number; clientY: number };
  const make = () => {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const el = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        (handlers[type] ||= []).push(h);
      },
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const fire = (type: string, e: { touches: T[]; targetTouches?: T[]; changedTouches: T[] }) => {
      for (const h of handlers[type] || []) h(e);
    };
    return { el, fire };
  };
  const touch = (identifier: number, clientX: number): T => ({ identifier, clientX, clientY: 0 });

  it("a new gesture after a missed touchend is recognised", () => {
    const { el, fire } = make();
    const s = swipe(el);
    fire("touchstart", { touches: [touch(1, 0)], changedTouches: [touch(1, 0)] });
    // touchend for id 1 never arrives.
    fire("touchstart", { touches: [touch(2, 0)], changedTouches: [touch(2, 0)] });
    fire("touchend", { touches: [], changedTouches: [touch(2, 200)] });
    expect(s.direction()).toBe("right");
    s.dispose();
  });

  it("a finger resting outside the target does not block a swipe on it", () => {
    const { el, fire } = make();
    const s = swipe(el);
    fire("touchstart", {
      touches: [touch(9, 500), touch(3, 0)],
      targetTouches: [touch(3, 0)],
      changedTouches: [touch(3, 0)],
    });
    fire("touchend", { touches: [touch(9, 500)], changedTouches: [touch(3, -200)] });
    expect(s.direction()).toBe("left");
    s.dispose();
  });

  it("two fingers on the target are still not a swipe", () => {
    const { el, fire } = make();
    const s = swipe(el);
    const both = [touch(1, 0), touch(2, 0)];
    fire("touchstart", { touches: both, targetTouches: both, changedTouches: [touch(2, 0)] });
    fire("touchend", { touches: [touch(1, 0)], changedTouches: [touch(2, 300)] });
    expect(s.direction()).toBeNull();
    s.dispose();
  });
});

// ---------------------------------------------------------------------------
// urlState: pushed entries do not inherit scroll-restoration identity.
// ---------------------------------------------------------------------------
describe("urlState entry identity", () => {
  it("push drops __sibuScrollKey, replace keeps it, other state is carried", () => {
    history.replaceState({ __sibuScrollKey: "K", app: 1 }, "", "/");
    const url = urlState();
    url.setParams({ q: "1" });
    expect(history.state).toEqual({ app: 1 });

    history.replaceState({ __sibuScrollKey: "K2", app: 2 }, "", "/");
    url.setParams({ q: "2" }, { replace: true });
    expect(history.state).toEqual({ __sibuScrollKey: "K2", app: 2 });

    url.setParams({ q: "3" }, { state: { __sibuScrollKey: "explicit" } });
    expect(history.state).toEqual({ __sibuScrollKey: "explicit" });
    url.dispose();
    history.replaceState(null, "", "/");
  });
});

// ---------------------------------------------------------------------------
// Head / renderToDocument: a null title from untyped callers is ignored.
// ---------------------------------------------------------------------------
describe("null titles", () => {
  it("Head({ title: null }) does not set the document title to 'null'", () => {
    document.title = "kept";
    const marker = Head({ title: null as unknown as string });
    expect(document.title).toBe("kept");
    dispose(marker);
  });

  it("renderToDocument({ title: null }) renders no <title>", () => {
    const html = renderToDocument(() => div("x") as HTMLElement, { title: null as unknown as string });
    expect(html).not.toContain("<title>");
  });
});

// ---------------------------------------------------------------------------
// Migrations: an unparseable stored version is reported, not thrown.
// ---------------------------------------------------------------------------
describe("migrate with a legacy stored version", () => {
  it("reports the invalid stored version in errors and runs nothing", async () => {
    const data = new Map<string, string>([["legacy", "1.0.0.1"]]);
    const storage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k: string) => data.get(k) ?? null,
      key: () => null,
      removeItem: (k: string) => void data.delete(k),
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
    const up = vi.fn();
    const runner = createMigrationRunner({
      currentVersion: "2.0.0",
      storage,
      storageKey: "legacy",
      migrations: [{ version: "2.0.0", description: "two", up }],
    });
    const result = await runner.migrate();
    expect(up).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].version).toBe("1.0.0.1");
    expect(result.errors[0].error.message).toMatch(/Invalid semver/);
  });
});

// ---------------------------------------------------------------------------
// Widget teardowns are idempotent across a rebind.
// ---------------------------------------------------------------------------
describe("stale widget teardown after rebind", () => {
  it("calling an old tooltip teardown again does not undo the new binding", () => {
    const trigger = document.createElement("button");
    const tip = document.createElement("div");
    document.body.append(trigger, tip);
    const t = tooltip();
    const first = t.bind({ trigger, tooltip: tip });
    first();
    const second = t.bind({ trigger, tooltip: tip });
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    first();
    expect(trigger.getAttribute("aria-describedby")).toBe(describedBy);
    expect(t.bind({ trigger, tooltip: tip })).toBe(second);
    second();
  });
});
