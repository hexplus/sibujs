import { afterEach, describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";
import { untracked } from "../src/reactivity/track";

describe("derived coverage2 — custom equals", () => {
  it("preserves prior reference when equals returns true", () => {
    const [n, setN] = signal({ v: 1 });
    const d = derived(() => ({ v: n().v }), { equals: (a, b) => a.v === b.v });
    const first = d();
    setN({ v: 1 }); // same .v → equals true → reference preserved
    expect(d()).toBe(first);
    setN({ v: 2 }); // different → new reference
    const third = d();
    expect(third).not.toBe(first);
    expect(third.v).toBe(2);
  });

  it("custom equals works with a legitimate undefined previous value", () => {
    const [n, setN] = signal<number | undefined>(undefined);
    const d = derived<number | undefined>(() => n(), { equals: (a, b) => a === b });
    expect(d()).toBeUndefined();
    setN(undefined);
    expect(d()).toBeUndefined();
    setN(5);
    expect(d()).toBe(5);
  });
});

describe("derived coverage2 — circular dependency", () => {
  it("throws when a derived reads itself", () => {
    const [enabled, setEnabled] = signal(false);
    let self: (() => number) | undefined;
    const d = derived<number>(() => {
      if (enabled() && self) return self() + 1;
      return 0;
    });
    self = d;
    expect(d()).toBe(0); // initial eval, enabled false
    setEnabled(true); // marks d dirty
    expect(() => d()).toThrow(/Circular dependency/);
  });

  it("includes the debug name in the circular error", () => {
    const [enabled, setEnabled] = signal(false);
    let self: (() => number) | undefined;
    const d = derived<number>(() => (enabled() && self ? self() : 0), { name: "myDerived" });
    self = d;
    expect(d()).toBe(0);
    setEnabled(true);
    expect(() => d()).toThrow(/myDerived/);
  });
});

describe("derived coverage2 — untracked / trackingSuspended read path", () => {
  it("re-evaluates a dirty derived when read inside untracked()", () => {
    const [n, setN] = signal(1);
    const d = derived(() => n() * 10);
    expect(d()).toBe(10);
    setN(2); // marks dirty
    const result = untracked(() => d());
    expect(result).toBe(20);
  });

  it("untracked read with custom equals preserves reference", () => {
    const [n, setN] = signal({ v: 1 });
    const d = derived(() => ({ v: n().v }), { equals: (a, b) => a.v === b.v });
    const first = untracked(() => d());
    setN({ v: 1 });
    const second = untracked(() => d());
    expect(second).toBe(first);
  });

  it("untracked read rethrows when getter throws", () => {
    const [shouldThrow, setShouldThrow] = signal(false);
    const d = derived(() => {
      if (shouldThrow()) throw new Error("derived boom");
      return 1;
    });
    expect(d()).toBe(1);
    setShouldThrow(true);
    expect(() => untracked(() => d())).toThrow("derived boom");
  });
});

describe("derived coverage2 — devtools hooks", () => {
  afterEach(() => {
    delete (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("emits computed:create with name and computed:update on change", () => {
    const events: Array<{ name: string; payload: any }> = [];
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (name: string, payload: any) => {
        events.push({ name, payload });
      },
    };
    const [n, setN] = signal(1);
    const d = derived(() => n() * 2, { name: "doubled" });
    expect(events.some((e) => e.name === "computed:create")).toBe(true);
    expect(d()).toBe(2);
    setN(5);
    expect(d()).toBe(10); // triggers re-eval + computed:update
    expect(events.some((e) => e.name === "computed:update")).toBe(true);
  });
});

describe("derived coverage2 — debugName tagging", () => {
  it("attaches __name to getter and signal when name provided", () => {
    const d = derived(() => 1, { name: "tagged" });
    expect((d as any).__name).toBe("tagged");
    expect((d as any).__signal.__name).toBe("tagged");
  });
});

describe("derived coverage2 — throw on re-eval sets dirty", () => {
  it("marks dirty and recovers when getter throws on re-eval", () => {
    const [mode, setMode] = signal<"ok" | "boom">("ok");
    const d = derived(() => {
      if (mode() === "boom") throw new Error("re-eval fail");
      return 42;
    });
    expect(d()).toBe(42);
    setMode("boom"); // marks dirty
    expect(() => d()).toThrow("re-eval fail");
    setMode("ok");
    expect(d()).toBe(42); // recovers
  });
});
