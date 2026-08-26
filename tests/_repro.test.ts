import { describe, expect, it, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";
import { getSubscriberCount } from "../src/reactivity/track";
import { sanitizeUrl } from "../src/utils/sanitize";

describe("REPRO A: derived equality propagation", () => {
  it("stable parity must not rerun downstream effect", () => {
    const [value, setValue] = signal(1);
    const parity = derived(() => value() % 2);
    let runs = 0;
    const dispose = effect(() => {
      parity();
      runs++;
    });
    expect(runs).toBe(1);
    setValue(3); // 1 -> 3, parity 1 -> 1
    expect(runs).toBe(1);
    dispose();
  });

  it("changed parity must rerun", () => {
    const [value, setValue] = signal(1);
    const parity = derived(() => value() % 2);
    let runs = 0;
    const dispose = effect(() => {
      parity();
      runs++;
    });
    setValue(2); // parity 1 -> 0
    expect(runs).toBe(2);
    dispose();
  });

  it("custom equals must suppress downstream", () => {
    const [source, setSource] = signal<{ x: number; ignored: string }>({ x: 1, ignored: "a" });
    const selected = derived(() => ({ x: source().x }), { equals: (a, b) => a?.x === b?.x });
    let runs = 0;
    const dispose = effect(() => {
      selected();
      runs++;
    });
    expect(runs).toBe(1);
    setSource({ x: 1, ignored: "b" });
    expect(runs).toBe(1);
    dispose();
  });
});

describe("REPRO C: production error observability", () => {
  it("effect rerun error is not swallowed", () => {
    const [count, setCount] = signal(0);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispose = effect(() => {
      if (count() === 1) throw new Error("boom-rerun");
    });
    setCount(1);
    // Something must have surfaced the error.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    dispose();
  });
});

describe("REPRO D: asyncDerived lifecycle", () => {
  it("exposes dispose and unsubscribes", async () => {
    const [src, setSrc] = signal(1);
    const state = asyncDerived(async () => src() * 2, 0);
    const sigState = (src as unknown as { __signal: object }).__signal;
    expect(getSubscriberCount(sigState as never)).toBeGreaterThan(0);
    expect(typeof (state as { dispose?: unknown }).dispose).toBe("function");
    (state as unknown as { dispose: () => void }).dispose();
    expect(getSubscriberCount(sigState as never)).toBe(0);
    setSrc(2);
  });
});

describe("REPRO B: each keyed row freshness", () => {
  it("same key, replaced object updates reactive content and keeps DOM identity", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const [users, setUsers] = signal<Array<{ id: number; name: string }>>([{ id: 1, name: "Alice" }]);

    const anchor = each(
      users,
      (user) => {
        const el = document.createElement("div");
        // reactive text binding
        const t = document.createTextNode("");
        el.appendChild(t);
        effect(() => {
          t.nodeValue = user().name;
        });
        return el;
      },
      { key: (u) => u.id },
    );
    host.appendChild(anchor);
    // force update now that anchor is connected
    setUsers([{ id: 1, name: "Alice" }]);

    const rowBefore = host.querySelector("div");
    expect(rowBefore?.textContent).toBe("Alice");

    setUsers([{ id: 1, name: "Bob" }]);
    const rowAfter = host.querySelector("div");
    expect(rowAfter).toBe(rowBefore); // DOM identity preserved
    expect(rowAfter?.textContent).toBe("Bob"); // freshness
    host.remove();
  });
});

describe("REPRO scheduler isolation", () => {
  it("runaway subscriber must not discard unrelated pending work", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [bad, setBad] = signal(0);
    const [good, setGood] = signal(0);
    let goodRuns = 0;

    const d1 = effect(() => {
      const v = bad();
      if (v < 500) setBad(v + 1); // self-driving runaway
    });
    const d2 = effect(() => {
      good();
      goodRuns++;
    });
    const baseline = goodRuns;

    batch(() => {
      setBad(1);
      setGood(1);
    });

    expect(goodRuns).toBe(baseline + 1);
    spy.mockRestore();
    d1();
    d2();
  });
});

describe("REPRO URL sanitizer normalization", () => {
  it("preserves interior spaces in legitimate URLs", () => {
    expect(sanitizeUrl("https://example.com/a b")).toBe("https://example.com/a b");
    expect(sanitizeUrl("mailto:a@b.com?subject=Hello World")).toBe("mailto:a@b.com?subject=Hello World");
  });
  it("still blocks obfuscated dangerous schemes", () => {
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x01javascript:alert(1)")).toBe("");
  });
});
