import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";

// Covers remaining uncovered branches of src/devtools/devtools.ts:
// - getElementHTML catch (outerHTML throwing)
// - buildData value resolution: computed dirty getter throwing -> _v fallback,
//   a node whose ref has a `value` but an unknown type, and the value catch ("?")
// - walkElement nested element direct-text collection and the attrs catch
// - state-change event serialization (object oldValue, null newValue, catch)
// - discoverComponents [data-component] branch via app:init
// - inferName falling through to a file-path match

type Hook = {
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  emit: (event: string, payload: unknown) => void;
  nodes: Map<number, unknown>;
  components: Map<string, unknown>;
};

function getHook(): Hook {
  return (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
}

function cleanup(): void {
  const prev = getActiveDevTools();
  if (prev) prev.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_VERSION__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_DATA__;
  document.body.innerHTML = "";
}

beforeEach(cleanup);
afterEach(cleanup);

describe("getElementHTML error handling", () => {
  it("returns null and warns when outerHTML access throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dt = initDevTools();
      const el = document.createElement("div");
      Object.defineProperty(el, "outerHTML", {
        get() {
          throw new Error("no html");
        },
      });
      dt.registerComponent("Broken", el);

      expect(dt.getElementHTML("Broken")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("buildData value resolution edge cases", () => {
  it("falls back to _v when a dirty computed getter throws", () => {
    initDevTools({ expose: true });
    const hook = getHook();
    hook.emit("computed:create", {
      signal: {
        _d: true,
        _g: () => {
          throw new Error("recompute failed");
        },
        _v: "fallback",
        __sc: 0,
      },
    });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { s: Array<{ v: string }> };
    expect(parsed.s[0].v).toBe("fallback");
  });

  it("reads value from ref.value for a node with an unrecognized type", () => {
    initDevTools({ expose: true });
    const hook = getHook();
    // emit under an event whose mapped node type is not signal/computed/effect.
    // computed:create produces type "computed"; to exercise the generic
    // "ref has value" branch we register via a custom node mutation.
    hook.emit("computed:create", { signal: { value: "vv", __sc: 0 } });
    const nodes = Array.from(hook.nodes.values()) as Array<{ type: string }>;
    // Force an unknown node type so buildData hits the generic value branch.
    nodes[0].type = "custom" as unknown as string;
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { s: Array<{ v: string }> };
    expect(parsed.s[0].v).toBe("vv");
  });

  it("yields '?' when reading the value throws", () => {
    initDevTools({ expose: true });
    const hook = getHook();
    const ref: Record<string, unknown> = {};
    Object.defineProperty(ref, "value", {
      enumerable: true,
      get() {
        throw new Error("value getter explodes");
      },
    });
    hook.emit("signal:create", { signal: ref, initial: 0 });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { s: Array<{ v: string }> };
    expect(parsed.s[0].v).toBe("?");
  });
});

describe("walkElement and state-change serialization", () => {
  it("collects direct text from nested element children", () => {
    const dt = initDevTools({ expose: true });
    const root = document.createElement("div");
    const wrapper = document.createElement("div");
    const inner = document.createElement("span");
    inner.textContent = "nested-text";
    wrapper.appendChild(inner);
    root.appendChild(wrapper);
    document.body.appendChild(root);
    dt.registerComponent("Tree", root);

    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { c: Array<{ kids: Array<{ txt: string }> }> };
    const tree = parsed.c.find((c) => (c as unknown as { n: string }).n === "Tree") as {
      kids: Array<{ txt: string }>;
    };
    expect(JSON.stringify(tree.kids)).toContain("nested-text");
  });

  it("serializes an object oldValue and a null newValue in state-change events", () => {
    const dt = initDevTools({ expose: true });
    dt.record({
      type: "state-change",
      component: "Form",
      key: "data",
      oldValue: { a: 1, b: 2 },
      newValue: null,
      timestamp: 1,
    });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { e: Array<{ t: string; ov: string; nv: string }> };
    const ev = parsed.e.find((e) => e.t === "state-change");
    expect(ev?.ov).toContain('"a"');
    expect(ev?.nv).toBe("null");
  });

  it("serializes undefined and null oldValue/newValue in state-change events", () => {
    const dt = initDevTools({ expose: true });
    dt.record({
      type: "state-change",
      component: "Form",
      key: "x",
      oldValue: undefined,
      newValue: null,
      timestamp: 3,
    });
    dt.record({
      type: "state-change",
      component: "Form",
      key: "y",
      oldValue: null,
      newValue: undefined,
      timestamp: 4,
    });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { e: Array<{ k: string; ov: string; nv: string }> };
    const x = parsed.e.find((e) => e.k === "x");
    const y = parsed.e.find((e) => e.k === "y");
    expect(x?.ov).toBe("undefined");
    expect(x?.nv).toBe("null");
    expect(y?.ov).toBe("null");
    expect(y?.nv).toBe("undefined");
  });

  it("stringifies primitive oldValue/newValue in state-change events", () => {
    const dt = initDevTools({ expose: true });
    dt.record({
      type: "state-change",
      component: "Form",
      key: "p",
      oldValue: 41,
      newValue: 42,
      timestamp: 5,
    });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { e: Array<{ k: string; ov: string; nv: string }> };
    const p = parsed.e.find((e) => e.k === "p");
    expect(p?.ov).toBe("41");
    expect(p?.nv).toBe("42");
  });

  it("yields '?' when serializing a value with a circular reference", () => {
    const dt = initDevTools({ expose: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    dt.record({
      type: "state-change",
      component: "Loop",
      key: "v",
      oldValue: circular,
      newValue: circular,
      timestamp: 2,
    });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { e: Array<{ t: string; ov: string; nv: string }> };
    const ev = parsed.e.find((e) => e.t === "state-change");
    expect(ev?.ov).toBe("?");
    expect(ev?.nv).toBe("?");
  });
});

describe("discoverComponents data-component branch", () => {
  it("discovers a [data-component] element on app:init", async () => {
    const dt = initDevTools();
    const hook = getHook();

    const el = document.createElement("div");
    el.setAttribute("data-component", "InitDiscovered");
    document.body.appendChild(el);

    hook.emit("app:init", { rootElement: el, container: document.body, duration: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(dt.getComponents().has("InitDiscovered")).toBe(true);
  });
});

describe("inferName file-path fallback", () => {
  it("derives a name from a file path when no usable function frame exists", () => {
    const RealError = globalThis.Error;
    const fakeStack = ["Error", "    at /home/app/components/Widget.tsx:12:9", "    at /home/app/main.tsx:1:1"].join(
      "\n",
    );
    // Replace the global Error so inferName()'s `new Error().stack` is fully
    // controlled. We return a plain object exposing only the crafted stack so
    // no V8-generated own `stack` property can shadow it.
    function FakeError(this: unknown) {
      return { stack: fakeStack } as unknown as Error;
    }
    (globalThis as unknown as { Error: unknown }).Error = FakeError;
    try {
      initDevTools();
      const hook = getHook();
      hook.emit("signal:create", { signal: { value: 1, __sc: 0 }, initial: 1 });
      const nodes = Array.from(hook.nodes.values()) as Array<{ name: string }>;
      expect(nodes[nodes.length - 1].name).toBe("Widget");
    } finally {
      (globalThis as unknown as { Error: unknown }).Error = RealError;
    }
  });

  it("returns 'anonymous' when building the stack throws", () => {
    const RealError = globalThis.Error;
    function ThrowingError() {
      throw new RealError("cannot build stack");
    }
    (globalThis as unknown as { Error: unknown }).Error = ThrowingError;
    try {
      initDevTools();
      const hook = getHook();
      hook.emit("signal:create", { signal: { value: 1, __sc: 0 }, initial: 1 });
      const nodes = Array.from(hook.nodes.values()) as Array<{ name: string }>;
      expect(nodes[nodes.length - 1].name).toBe("anonymous");
    } finally {
      (globalThis as unknown as { Error: unknown }).Error = RealError;
    }
  });
});
