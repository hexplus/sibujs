import { afterEach, describe, expect, it, vi } from "vitest";
import { derived } from "@sibujs/core";
import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { store } from "@sibujs/core";
import { watch } from "@sibujs/core";
import { disableSSR, enableSSR, isSSR, withSSR } from "@sibujs/core";
import { deserializeState, renderToString, serializeState } from "../src/platform/ssr";

afterEach(() => {
  disableSSR();
});

// ── SSR context ──────────────────────────────────────────────────────────────

describe("SSR context", () => {
  it("isSSR returns false by default", () => {
    expect(isSSR()).toBe(false);
  });

  it("enableSSR / disableSSR toggle SSR mode", () => {
    enableSSR();
    expect(isSSR()).toBe(true);
    disableSSR();
    expect(isSSR()).toBe(false);
  });

  it("withSSR runs callback in SSR mode and restores after", () => {
    expect(isSSR()).toBe(false);
    const result = withSSR(() => {
      expect(isSSR()).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(isSSR()).toBe(false);
  });

  it("withSSR restores SSR mode even if callback throws", () => {
    expect(() => {
      withSSR(() => {
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(isSSR()).toBe(false);
  });
});

// ── Signals work during SSR (read/write are pure) ────────────────────────────

describe("Signals during SSR", () => {
  it("signal works normally in SSR mode (no side effects)", () => {
    enableSSR();
    const [count, setCount] = signal(0);
    expect(count()).toBe(0);
    setCount(5);
    expect(count()).toBe(5);
  });

  it("derived works normally in SSR mode", () => {
    enableSSR();
    const [count, setCount] = signal(3);
    const doubled = derived(() => count() * 2);
    expect(doubled()).toBe(6);
    setCount(10);
    expect(doubled()).toBe(20);
  });

  it("store works normally in SSR mode", () => {
    enableSSR();
    const [s, { setState }] = store({ name: "Alice", age: 30 });
    expect(s.name).toBe("Alice");
    setState({ age: 31 });
    expect(s.age).toBe(31);
  });
});

// ── Effects are no-ops during SSR ────────────────────────────────────────────

describe("effect is a no-op during SSR", () => {
  it("does not run the effect function", () => {
    enableSSR();
    const spy = vi.fn();
    const teardown = effect(spy);
    expect(spy).not.toHaveBeenCalled();
    expect(typeof teardown).toBe("function");
  });

  it("returned teardown is a safe no-op", () => {
    enableSSR();
    const teardown = effect(() => {});
    expect(() => teardown()).not.toThrow();
  });

  it("does not subscribe to signals", () => {
    enableSSR();
    const [count, setCount] = signal(0);
    const spy = vi.fn();
    effect(() => spy(count()));
    setCount(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Watch is a no-op during SSR ──────────────────────────────────────────────

describe("watch is a no-op during SSR", () => {
  it("does not call the callback", () => {
    enableSSR();
    const [count, setCount] = signal(0);
    const spy = vi.fn();
    watch(count, spy);
    setCount(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returned teardown is a safe no-op", () => {
    enableSSR();
    const [count] = signal(0);
    const teardown = watch(count, () => {});
    expect(() => teardown()).not.toThrow();
  });
});

// ── Effects resume after SSR mode is disabled ────────────────────────────────

describe("Effects resume after SSR", () => {
  it("effect works normally after disableSSR()", () => {
    enableSSR();
    const spy1 = vi.fn();
    effect(spy1);
    expect(spy1).not.toHaveBeenCalled();

    disableSSR();
    const spy2 = vi.fn();
    const teardown = effect(spy2);
    expect(spy2).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("watch works normally after disableSSR()", () => {
    const [count, setCount] = signal(0);
    enableSSR();
    const spy1 = vi.fn();
    watch(count, spy1);

    disableSSR();
    const spy2 = vi.fn();
    const teardown = watch(count, spy2);
    setCount(1);
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).toHaveBeenCalledWith(1, 0);
    teardown();
  });
});

// ── State serialization / deserialization ────────────────────────────────────

describe("State serialization for client handoff", () => {
  it("serializeState produces a script tag with JSON", () => {
    const html = serializeState({ count: 42, name: "Alice" });
    expect(html).toContain("<script>");
    expect(html).toContain("__SIBU_SSR_DATA__");
    expect(html).toContain("42");
    expect(html).toContain("Alice");
  });

  it("serializeState escapes < > & to prevent injection", () => {
    const html = serializeState({ payload: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003c");
  });

  it("deserializeState returns undefined when not in browser", () => {
    // In test environment window exists but __SIBU_SSR_DATA__ doesn't
    const result = deserializeState();
    expect(result).toBeUndefined();
  });

  it("round-trip: serialize → set on window → deserialize", () => {
    const state = { count: 99, items: ["a", "b"] };
    // Simulate what the server does
    const script = serializeState(state);
    // Extract the JSON from the script tag and eval it
    const match = script.match(/window\.__SIBU_SSR_DATA__=(.+)<\/script>/);
    expect(match).toBeTruthy();
    const json = match?.[1]
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0026/g, "&");
    (window as any).__SIBU_SSR_DATA__ = JSON.parse(json);

    const result = deserializeState<{ count: number; items: string[] }>();
    expect(result).toEqual(state);

    delete (window as any).__SIBU_SSR_DATA__;
  });
});

// ── Full SSR rendering with withSSR ──────────────────────────────────────────

describe("Full SSR render with withSSR", () => {
  it("renders component without side effects", () => {
    const effectSpy = vi.fn();
    const watchSpy = vi.fn();

    const html = withSSR(() => {
      const [count] = signal(42);
      const doubled = derived(() => count() * 2);

      // These should be no-ops during SSR
      effect(() => effectSpy(count()));
      watch(() => count(), watchSpy);

      // Build DOM for rendering
      const el = document.createElement("div");
      el.className = "app";
      el.textContent = `Count: ${count()}, Doubled: ${doubled()}`;
      return renderToString(el);
    });

    expect(html).toContain('class="app"');
    expect(html).toContain("Count: 42, Doubled: 84");
    expect(effectSpy).not.toHaveBeenCalled();
    expect(watchSpy).not.toHaveBeenCalled();
  });
});
