/**
 * Router lifecycle, redirect-bounding, and listener-hygiene suite.
 *
 * Invariants under test:
 *  - Redirect resolution must terminate or fail with a bounded diagnostic.
 *  - A stale lazy route resolution may not mount UI.
 *  - Repeated router create/destroy must not accumulate global listeners.
 *  - A destroyed router may never commit future navigation state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter, navigate, Route, route, setRoutes } from "../src/plugins/router";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const el = (text: string) => () => {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
};

describe("router hardening: redirects are bounded", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("terminates a two-route redirect cycle instead of recursing forever", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/login", redirect: "/dashboard" },
      { path: "/dashboard", redirect: "/login" },
    ]);

    const result = await navigate("/login");

    // Bounded: it fails rather than hanging or blowing the stack.
    expect(result.success).toBe(false);
    expect(result.type).toBe("aborted");
  });

  it("terminates a self-redirect", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/loop", redirect: "/loop" },
    ]);

    const result = await navigate("/loop");
    expect(result.success).toBe(false);
  });

  it("terminates a three-route redirect cycle", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", redirect: "/b" },
      { path: "/b", redirect: "/c" },
      { path: "/c", redirect: "/a" },
    ]);

    const result = await navigate("/a");
    expect(result.success).toBe(false);
  });

  it("still follows a legitimate redirect chain to completion", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/old", redirect: "/mid" },
      { path: "/mid", redirect: "/new" },
      { path: "/new", component: el("new") },
    ]);

    const result = await navigate("/old");
    expect(result.success).toBe(true);
    expect(route().path).toBe("/new");
  });

  it("resolves a guard-issued redirect", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/private", component: el("private"), beforeEnter: () => "/login" },
      { path: "/login", component: el("login") },
    ]);

    await navigate("/private");
    expect(route().path).toBe("/login");
  });
});

describe("router hardening: lazy route supersession", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("a stale lazy import must not mount its UI into the Outlet", async () => {
    const gate = deferred<{ default: () => Element }>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", lazy: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    // Render the actual route outlet — the lazy race lives at the DOM mount
    // layer (Route's navSeq), not in performNavigation, which never awaits
    // component loading.
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());

    try {
      await navigate("/slow");
      await settle();

      // Supersede while the lazy chunk is still in flight.
      await navigate("/fast");
      await settle();
      expect(host.textContent).toContain("fast");

      // The abandoned chunk lands late — it must not replace the live UI.
      gate.resolve({ default: el("slow") });
      await settle();

      expect(host.textContent).toContain("fast");
      expect(host.textContent).not.toContain("slow");
      expect(route().path).toBe("/fast");
    } finally {
      host.remove();
    }
  });

  it("mounts a lazy route once its import resolves while still current", async () => {
    const gate = deferred<{ default: () => Element }>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/lazy", lazy: () => gate.promise },
    ]);

    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());

    try {
      await navigate("/lazy");
      await settle();

      gate.resolve({ default: el("lazy-content") });
      await settle();

      expect(host.textContent).toContain("lazy-content");
    } finally {
      host.remove();
    }
  });

  it("a rejected lazy import does not leave the router half-committed", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/broken", lazy: () => Promise.reject(new Error("chunk load failed")) },
    ]);

    const before = route().path;
    const result = await navigate("/broken");
    await settle();

    // Whatever the outcome, path and history must agree with each other.
    expect(typeof result.success).toBe("boolean");
    expect(window.location.pathname).toBe(route().path === before ? before : route().path);
  });
});

describe("router hardening: teardown safety", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("does not accumulate popstate listeners across create/destroy cycles", () => {
    const added = new Map<string, number>();
    const removed = new Map<string, number>();

    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);

    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      added.set(type, (added.get(type) ?? 0) + 1);
      return (origAdd as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof window.addEventListener);

    vi.spyOn(window, "removeEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      removed.set(type, (removed.get(type) ?? 0) + 1);
      return (origRemove as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof window.removeEventListener);

    for (let i = 0; i < 50; i++) {
      createRouter({ mode: "history", base: "" });
      setRoutes([{ path: "/", component: el("home") }]);
      destroyRouter();
    }

    // Every listener type the router installs must be removed as often as it
    // is added — otherwise repeated create/destroy leaks handlers.
    for (const [type, addedCount] of added) {
      const removedCount = removed.get(type) ?? 0;
      expect(
        removedCount,
        `listener type "${type}": added ${addedCount}, removed ${removedCount}`,
      ).toBeGreaterThanOrEqual(addedCount);
    }
  });

  it("survives 500 back-and-forth navigations with a stable final state", async () => {
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", component: el("a") },
      { path: "/b", component: el("b") },
    ]);

    for (let i = 0; i < 500; i++) {
      await navigate(i % 2 === 0 ? "/a" : "/b");
    }

    expect(route().path).toBe("/b");
    expect(window.location.pathname).toBe("/b");
  });

  it("a navigation started before destroy cannot mutate history afterwards", async () => {
    const gate = deferred<boolean>();
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
    ]);

    const nav = navigate("/slow");
    await settle();

    destroyRouter();
    const pathAfterDestroy = window.location.pathname;
    const lengthAfterDestroy = window.history.length;

    gate.resolve(true);
    await Promise.allSettled([nav]);
    await settle();

    expect(window.location.pathname).toBe(pathAfterDestroy);
    expect(window.history.length).toBe(lengthAfterDestroy);
  });
});

describe("router hardening: same-route and partial navigation (characterization)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/users/:id", component: el("user") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("reports a repeated identical navigation as duplicated", async () => {
    await navigate("/users/1");
    expect(route().path).toBe("/users/1");

    const second = await navigate("/users/1");

    // Current documented behaviour: an identical target is rejected as a
    // duplicate rather than re-running the pipeline.
    expect(second.success).toBe(false);
    expect(second.type).toBe("duplicated");
    expect(route().path).toBe("/users/1");
  });

  it("treats a query-only change as a real navigation", async () => {
    await navigate("/users/1");
    const result = await navigate("/users/1?tab=posts");

    expect(result.success).toBe(true);
    expect(route().query.tab).toBe("posts");
  });

  it("treats a hash-only change as a real navigation", async () => {
    await navigate("/users/1");
    const result = await navigate("/users/1#bio");

    expect(result.success).toBe(true);
    expect(route().hash).toBe("bio");
  });

  it("extracts and decodes route params", async () => {
    await navigate("/users/hello%20world");
    expect(route().params.id).toBe("hello world");
  });

  it("does not crash on a malformed percent-encoded param", async () => {
    const result = await navigate("/users/%E0%A4%A");
    // Either outcome is acceptable; crashing the router is not.
    expect(typeof result.success).toBe("boolean");
  });
});

describe("router hardening: redirect loop diagnostics", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("names the offending hop sequence when a loop is detected", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/login", redirect: "/dashboard" },
      { path: "/dashboard", redirect: "/login" },
    ]);

    await navigate("/login");

    const loopWarning = warnings.find((w) => w.includes("redirect loop"));
    expect(loopWarning).toBeDefined();
    // The message must show the actual cycle, not just say one happened.
    expect(loopWarning).toContain('"/login"');
    expect(loopWarning).toContain('"/dashboard"');
    expect(loopWarning).toContain("->");
  });
});
