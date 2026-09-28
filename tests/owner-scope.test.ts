/**
 * Owner scope — an opaque value that follows reactive ownership, not the call
 * stack.
 *
 * Invariants under test:
 *  - A subscriber (effect, derived, binding) stamps the scope current at its
 *    first run and reinstates it for every later run, whoever triggers it.
 *  - Subscribers created during another subscriber's run inherit its scope.
 *  - Effect cleanups run in the effect's scope, on re-run and on dispose.
 *  - The framework's deferred first renders (`when`, `match`, `each`, lazy,
 *    Suspense, Portal, `onMount`, `onUnmount`) carry the scope they were
 *    created in.
 *  - Scopes never leak: the previous scope is restored after every run, even
 *    one that throws.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { match, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { onMount, onUnmount } from "../src/core/rendering/lifecycle";
import { Portal } from "../src/core/rendering/portal";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { createChunkRegistry, lazyChunk } from "../src/performance/chunkLoader";
import { defineRemoteComponent } from "../src/platform/microfrontend";
import { bindOwnerScope, getOwnerScope, runWithOwnerScope } from "../src/reactivity/track";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()?.();
  document.body.innerHTML = "";
});

describe("owner scope: core propagation", () => {
  it("is null outside any scope and restored after runWithOwnerScope, even on throw", () => {
    expect(getOwnerScope()).toBeNull();
    const scope = { name: "a" };
    expect(runWithOwnerScope(scope, () => getOwnerScope())).toBe(scope);
    expect(() =>
      runWithOwnerScope(scope, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getOwnerScope()).toBeNull();
  });

  it("an effect reinstates its creation scope on every re-run, from any trigger site", () => {
    const [n, setN] = signal(0);
    const seen: unknown[] = [];
    const scope = { name: "page" };
    runWithOwnerScope(scope, () => {
      stops.push(
        effect(() => {
          n();
          seen.push(getOwnerScope());
        }),
      );
    });
    setN(1);
    runWithOwnerScope({ name: "other" }, () => setN(2));
    expect(seen).toEqual([scope, scope, scope]);
    expect(getOwnerScope()).toBeNull();
  });

  it("an effect created outside any scope stays unscoped when re-run inside one", () => {
    const [n, setN] = signal(0);
    const seen: unknown[] = [];
    stops.push(
      effect(() => {
        n();
        seen.push(getOwnerScope());
      }),
    );
    runWithOwnerScope({ name: "other" }, () => setN(1));
    expect(seen).toEqual([null, null]);
  });

  it("a derived recomputes in its creation scope, whoever pulls it", () => {
    const [n, setN] = signal(0);
    const scope = { name: "page" };
    const d = runWithOwnerScope(scope, () => derived(() => [n(), getOwnerScope()] as const));
    expect(d()[1]).toBe(scope);
    setN(1);
    expect(runWithOwnerScope({ name: "reader" }, () => d())[1]).toBe(scope);
    d.dispose();
  });

  it("subscribers created during a run inherit the running subscriber's scope", () => {
    const [show, setShow] = signal(false);
    const inner: unknown[] = [];
    const scope = { name: "page" };
    runWithOwnerScope(scope, () => {
      stops.push(
        effect(() => {
          if (!show()) return;
          stops.push(effect(() => inner.push(getOwnerScope())));
        }),
      );
    });
    setShow(true);
    expect(inner).toEqual([scope]);
  });

  it("effect cleanups run in the effect's scope on re-run and on dispose", () => {
    const [n, setN] = signal(0);
    const cleanups: unknown[] = [];
    const scope = { name: "page" };
    const stop = runWithOwnerScope(scope, () =>
      effect((onCleanup) => {
        n();
        onCleanup(() => cleanups.push(getOwnerScope()));
      }),
    );
    setN(1);
    runWithOwnerScope({ name: "disposer" }, () => stop());
    expect(cleanups).toEqual([scope, scope]);
  });

  it("an unscoped effect's cleanup runs unscoped, even when disposed inside a scope", () => {
    const cleanups: unknown[] = [];
    const stop = effect((onCleanup) => {
      onCleanup(() => cleanups.push(getOwnerScope()));
    });
    runWithOwnerScope({ name: "disposer" }, () => stop());
    expect(cleanups).toEqual([null]);
  });

  it("a derived created outside any scope is not stamped by a scoped first recompute", () => {
    const [n, setN] = signal(0);
    const d = derived(() => [n(), getOwnerScope()] as const);
    setN(1);
    expect(runWithOwnerScope({ name: "reader" }, () => d())[1]).toBeNull();
    setN(2);
    expect(d()[1]).toBeNull();
    d.dispose();
  });

  it("bindOwnerScope carries the scope into deferred work, and is the identity without one", async () => {
    const fn = () => getOwnerScope();
    expect(bindOwnerScope(fn)).toBe(fn);
    const scope = { name: "page" };
    const bound = runWithOwnerScope(scope, () => bindOwnerScope(fn));
    expect(bound()).toBe(scope);
    const later = await new Promise((r) => queueMicrotask(() => r(bound())));
    expect(later).toBe(scope);
  });
});

describe("owner scope: deferred renders carry the creation scope", () => {
  const scope = { name: "page" };

  /** Build `make()` in `scope`, attach it after creation (as outlets do), and report what its content saw. */
  async function scopeSeenBy(make: (probe: () => Node) => Node): Promise<unknown[]> {
    const seen: unknown[] = [];
    const probe = () => {
      stops.push(effect(() => seen.push(getOwnerScope())));
      return document.createElement("i");
    };
    const host = document.createElement("div");
    const node = runWithOwnerScope(scope, () => make(probe));
    host.appendChild(node);
    document.body.appendChild(host);
    await flush();
    stops.push(() => dispose(host));
    return seen;
  }

  it("when()", async () => {
    expect(await scopeSeenBy((probe) => when(() => true, probe) as unknown as Node)).toEqual([scope]);
  });

  it("match()", async () => {
    expect(await scopeSeenBy((probe) => match(() => "a", { a: probe }) as unknown as Node)).toEqual([scope]);
  });

  it("each()", async () => {
    const seen = await scopeSeenBy(
      (probe) =>
        each(
          () => [1, 2],
          () => probe(),
          { key: (x) => x },
        ) as unknown as Node,
    );
    expect(seen).toEqual([scope, scope]);
  });

  it("lazy() and Suspense", async () => {
    const seen: unknown[] = [];
    const Probe = () => {
      stops.push(effect(() => seen.push(getOwnerScope())));
      return document.createElement("b");
    };
    const Lazy = lazy(() => Promise.resolve({ default: Probe }));
    const host = document.createElement("div");
    host.appendChild(
      runWithOwnerScope(scope, () =>
        Suspense({ nodes: () => Lazy() as Element, fallback: () => document.createElement("span") }),
      ),
    );
    document.body.appendChild(host);
    await flush();
    stops.push(() => dispose(host));
    expect(seen).toEqual([scope]);
  });

  it("lazyChunk()", async () => {
    const seen: unknown[] = [];
    const Probe = () => {
      stops.push(effect(() => seen.push(getOwnerScope())));
      return document.createElement("b");
    };
    const Chunk = lazyChunk("probe-chunk", () => Promise.resolve({ default: Probe }), createChunkRegistry());
    const host = document.createElement("div");
    host.appendChild(runWithOwnerScope(scope, () => Chunk()));
    document.body.appendChild(host);
    await flush();
    stops.push(() => dispose(host));
    expect(seen).toEqual([scope]);
  });

  it("defineRemoteComponent()", async () => {
    const seen: unknown[] = [];
    const Probe = () => {
      stops.push(effect(() => seen.push(getOwnerScope())));
      return document.createElement("b");
    };
    const Remote = defineRemoteComponent("probe-remote", () => Promise.resolve({ default: Probe }));
    const host = document.createElement("div");
    host.appendChild(runWithOwnerScope(scope, () => Remote()));
    document.body.appendChild(host);
    await flush();
    stops.push(() => dispose(host));
    expect(seen).toEqual([scope]);
  });

  it("ErrorBoundary: the fallback for a rejected async child", async () => {
    const seen: unknown[] = [];
    const host = document.createElement("div");
    host.appendChild(
      runWithOwnerScope(scope, () =>
        ErrorBoundary(
          {
            fallback: () => {
              stops.push(effect(() => seen.push(getOwnerScope())));
              return document.createElement("b");
            },
          },
          () => Promise.reject(new Error("boom")) as unknown as Element,
        ),
      ),
    );
    document.body.appendChild(host);
    await flush();
    stops.push(() => dispose(host));
    // Rendered once from the rejection handler and again when the boundary
    // re-renders on its error state: both in the boundary's scope.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === scope)).toBe(true);
  });

  it("Portal()", async () => {
    expect(await scopeSeenBy((probe) => Portal(() => probe() as Element))).toEqual([scope]);
  });

  it("onMount() and onUnmount()", async () => {
    const seen: unknown[] = [];
    const el = document.createElement("div");
    runWithOwnerScope(scope, () => {
      onMount(() => {
        seen.push(getOwnerScope());
        return undefined;
      }, el);
      onUnmount(() => seen.push(getOwnerScope()), el);
    });
    document.body.appendChild(el);
    await flush();
    dispose(el);
    expect(seen).toEqual([scope, scope]);
  });
});

describe("owner scope: a cleanup returned by onMount() keeps the registration scope", () => {
  const scope = { name: "page" };

  /** Register `onMount` in `registrationScope`; the cleanup it returns records its scope. */
  function mountWithCleanup(
    el: Element,
    registrationScope: unknown,
    onMounted: () => void = () => {},
  ): { mounted: unknown[]; cleaned: unknown[] } {
    const mounted: unknown[] = [];
    const cleaned: unknown[] = [];
    runWithOwnerScope(registrationScope, () => {
      onMount(() => {
        mounted.push(getOwnerScope());
        onMounted();
        return () => {
          cleaned.push(getOwnerScope());
        };
      }, el);
    });
    return { mounted, cleaned };
  }

  it("the onMount callback runs in the registration scope", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { mounted } = mountWithCleanup(el, scope);
    await flush();
    expect(mounted).toEqual([scope]);
    dispose(el);
  });

  it("on a normal dispose", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { mounted, cleaned } = mountWithCleanup(el, scope);
    await flush();
    dispose(el);
    expect(mounted).toEqual([scope]);
    expect(cleaned).toEqual([scope]);
  });

  it("on a native removal, seen by the observer", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { cleaned } = mountWithCleanup(el, scope);
    await flush();
    el.remove();
    await flush();
    expect(cleaned).toEqual([scope]);
  });

  it("when the mount callback removes its own element (cleanup runs immediately)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { cleaned } = mountWithCleanup(el, scope, () => el.remove());
    await flush();
    expect(cleaned).toEqual([scope]);
  });

  it("when the mount callback disposes its own element (cleanup runs immediately)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { cleaned } = mountWithCleanup(el, scope, () => dispose(el));
    await flush();
    expect(cleaned).toEqual([scope]);
  });

  it("when the element connects after registration (observer-driven mount)", async () => {
    const el = document.createElement("div");
    const { mounted, cleaned } = mountWithCleanup(el, scope);
    await flush();
    document.body.appendChild(el);
    await flush();
    dispose(el);
    expect(mounted).toEqual([scope]);
    expect(cleaned).toEqual([scope]);
  });

  it("disposing from another owner scope does not change the cleanup's scope", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { cleaned } = mountWithCleanup(el, scope);
    await flush();
    runWithOwnerScope({ name: "disposer" }, () => dispose(el));
    expect(cleaned).toEqual([scope]);
  });

  it("an unscoped registration stays unscoped, whoever disposes it", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const { mounted, cleaned } = mountWithCleanup(el, null);
    await flush();
    runWithOwnerScope({ name: "disposer" }, () => dispose(el));
    expect(mounted).toEqual([null]);
    expect(cleaned).toEqual([null]);
  });

  it("an onUnmount callback keeps its registration scope, whoever disposes it", async () => {
    const seen: unknown[] = [];
    const scoped = document.createElement("div");
    const unscoped = document.createElement("div");
    document.body.append(scoped, unscoped);
    runWithOwnerScope(scope, () => onUnmount(() => seen.push(getOwnerScope()), scoped));
    onUnmount(() => seen.push(getOwnerScope()), unscoped);
    runWithOwnerScope({ name: "disposer" }, () => {
      dispose(scoped);
      dispose(unscoped);
    });
    expect(seen).toEqual([scope, null]);
  });
});
