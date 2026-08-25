/**
 * Cleanup-mismatch detection.
 *
 * These tests assert the disposal invariant *without* depending on garbage
 * collection: `checkLeaks()` reports the number of live DOM bindings, so a
 * mount/destroy cycle that fails to tear something down shows up as a counter
 * that never returns to its baseline. GC-dependent assertions are confined to
 * the WeakRef section at the end, which is skipped when the runtime does not
 * expose `global.gc`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { checkLeaks, dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { div, span } from "../src/core/rendering/html";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { Suspense } from "../src/core/rendering/lazy";
import { Portal } from "../src/core/rendering/portal";
import { signal } from "../src/core/signals/signal";
import { bindChildNode } from "../src/reactivity/bindChildNode";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));
const flush = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

describe("hardening: binding-count returns to baseline", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  /**
   * Run `cycle` repeatedly and assert the live-binding count is identical
   * before and after. A leak shows up as monotonic growth.
   */
  async function expectNoGrowth(cycle: () => Promise<void> | void, iterations = 25) {
    // Warm up once so first-run lazily-created singletons aren't counted.
    await cycle();
    const baseline = checkLeaks();

    for (let i = 0; i < iterations; i++) {
      await cycle();
    }

    expect(checkLeaks()).toBe(baseline);
  }

  it("each(): create → populate → destroy leaves no live bindings", async () => {
    await expectNoGrowth(async () => {
      const [items, setItems] = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
      const anchor = each(items, (item) => div(() => `row ${item().id}`) as Node, { key: (i) => i.id });
      host.appendChild(anchor);
      await tick();

      setItems([{ id: 3 }, { id: 4 }]);
      await tick();

      dispose(anchor);
      anchor.remove();
    });
  });

  it("conditional branch swapping each() in and out leaves no live bindings", async () => {
    await expectNoGrowth(async () => {
      const [visible, setVisible] = signal(true);
      const [items] = signal([{ id: 1 }, { id: 2 }]);

      const placeholder = document.createComment("branch");
      host.appendChild(placeholder);
      const stop = bindChildNode(placeholder, () =>
        visible()
          ? each(items, (item) => div(() => `row ${item().id}`) as Node, { key: (i) => i.id })
          : (span("gone") as Node),
      );
      await tick();

      setVisible(false);
      await tick();

      stop();
      dispose(placeholder);
      placeholder.remove();
      host.replaceChildren();
    });
  });

  it("Suspense: mount → resolve → destroy leaves no live bindings", async () => {
    await expectNoGrowth(async () => {
      const [progress] = signal(0);
      const container = Suspense({
        nodes: () => div({ id: "content" }, "done") as HTMLElement,
        fallback: () => div(() => `${progress()}%`) as HTMLElement,
      });
      host.appendChild(container);
      await flush();

      dispose(container);
      container.remove();
    }, 15);
  });

  it("Portal: mount → destroy leaves no live bindings and no orphan DOM", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    await expectNoGrowth(async () => {
      const [label] = signal("x");
      const anchor = Portal(() => div(() => label()) as HTMLElement, target);
      host.appendChild(anchor);
      await flush();

      dispose(anchor);
      anchor.remove();
    }, 15);

    expect(target.childNodes).toHaveLength(0);
  });

  it("KeepAlive: cache churn and eviction leave no live bindings", async () => {
    await expectNoGrowth(async () => {
      const [key, setKey] = signal("a");
      const anchor = KeepAlive(
        key,
        {
          a: () => div(() => "A") as Node,
          b: () => div(() => "B") as Node,
          c: () => div(() => "C") as Node,
        },
        { max: 2 },
      );
      host.appendChild(anchor);
      await tick();

      // Force an LRU eviction: three keys through a cache of 2.
      setKey("b");
      await tick();
      setKey("c");
      await tick();

      dispose(anchor);
      anchor.remove();
    }, 15);
  });

  it("ErrorBoundary: mount → destroy leaves no live bindings", async () => {
    await expectNoGrowth(async () => {
      const [n] = signal(1);
      const boundary = ErrorBoundary(
        { fallback: () => div("failed") as unknown as Element },
        () => div(() => `n=${n()}`) as unknown as Element,
      ) as unknown as HTMLElement;
      host.appendChild(boundary);
      await flush();

      dispose(boundary);
      boundary.remove();
    }, 15);
  });

  it("does not grow across 200 nested mount/destroy cycles", async () => {
    await expectNoGrowth(async () => {
      const [items] = signal([{ id: 1 }, { id: 2 }]);
      const outer = div(
        {},
        div(
          {},
          each(items, (item) => div(() => `${item().id}`) as Node, { key: (i) => i.id }),
        ),
      ) as HTMLElement;
      host.appendChild(outer);
      await tick();

      dispose(outer);
      outer.remove();
    }, 200);
  });
});

describe("hardening: KeepAlive eviction disposes exactly once", () => {
  it("disposes an evicted subtree once and only once", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const disposals: string[] = [];
    const make = (name: string) => () => {
      const el = div(name) as HTMLElement;
      registerDisposer(el, () => disposals.push(name));
      return el;
    };

    const [key, setKey] = signal("a");
    const anchor = KeepAlive(key, { a: make("a"), b: make("b"), c: make("c") }, { max: 1 });
    host.appendChild(anchor);
    await tick();

    // max: 1 — every switch evicts the previous entry.
    setKey("b");
    await tick();
    expect(disposals).toEqual(["a"]);

    setKey("c");
    await tick();
    expect(disposals).toEqual(["a", "b"]);

    // Tearing down the anchor disposes whatever is still cached — once each.
    dispose(anchor);
    anchor.remove();
    expect(disposals).toEqual(["a", "b", "c"]);

    // Idempotent: a second teardown must not re-fire any of them.
    dispose(anchor);
    expect(disposals).toEqual(["a", "b", "c"]);
  });
});

/**
 * GC-dependent checks. Skipped unless the suite runs under `--expose-gc`,
 * because collection timing is not deterministic.
 */
const gc = (globalThis as { gc?: () => void }).gc;
describe.skipIf(!gc)("hardening: garbage collection", () => {
  it("releases disposed component subtrees", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const refs: WeakRef<HTMLElement>[] = [];
    for (let i = 0; i < 200; i++) {
      const [items] = signal([{ id: 1 }, { id: 2 }]);
      const el = div(
        {},
        each(items, (item) => div(() => `${item().id}`) as Node, { key: (r) => r.id }),
      ) as HTMLElement;
      host.appendChild(el);
      await tick();
      dispose(el);
      el.remove();
      refs.push(new WeakRef(el));
    }

    gc?.();
    await new Promise((r) => setTimeout(r, 50));
    gc?.();

    const alive = refs.filter((r) => r.deref() !== undefined).length;
    // Allow slack for the most recent allocations still on the stack.
    expect(alive).toBeLessThan(refs.length / 2);
  });
});
