/**
 * Navigation-result semantics.
 *
 * `type: "aborted"` alone cannot tell a caller whether the user was denied
 * access, clicked a newer link, or tore the router down. These tests pin the
 * `reason` discriminator that separates them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter, navigate, route, setRoutes } from "../src/plugins/router";

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

describe("router hardening: navigation failure reasons are distinguishable", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("reports reason 'guard' when a beforeEnter guard blocks", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/private", component: el("private"), beforeEnter: () => false },
    ]);

    const result = await navigate("/private");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.type).toBe("aborted");
    expect(result.reason).toBe("guard");
    expect(result.failure.reason).toBe("guard");
  });

  it("reports reason 'guard' when a global beforeEach guard blocks", async () => {
    const { beforeEach: routerBeforeEach } = await import("../src/plugins/router");
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/x", component: el("x") },
    ]);

    const off = routerBeforeEach((_to, _from, next) => next(false));
    const result = await navigate("/x");
    off();

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("guard");
  });

  it("reports reason 'superseded' when a newer navigation takes over", async () => {
    const gate = deferred<boolean>();
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    const slowNav = navigate("/slow");
    await settle();
    await navigate("/fast");

    gate.resolve(true);
    const result = await slowNav;

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.type).toBe("aborted");
    expect(result.reason).toBe("superseded");
    expect(route().path).toBe("/fast");
  });

  it("reports reason 'router-destroyed' when teardown cancels a pending navigation", async () => {
    const gate = deferred<boolean>();
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
    ]);

    const slowNav = navigate("/slow");
    await settle();

    destroyRouter();
    gate.resolve(true);
    const result = await slowNav;

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("router-destroyed");
  });

  it("distinguishes guard rejection from supersession in the same suite", async () => {
    const gate = deferred<boolean>();
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/blocked", component: el("blocked"), beforeEnter: () => false },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    const blocked = await navigate("/blocked");

    const slowNav = navigate("/slow");
    await settle();
    await navigate("/fast");
    gate.resolve(true);
    const superseded = await slowNav;

    if (blocked.success || superseded.success) throw new Error("unreachable");

    // Same `type`, different `reason` — that is the whole point.
    expect(blocked.type).toBe(superseded.type);
    expect(blocked.reason).toBe("guard");
    expect(superseded.reason).toBe("superseded");
    expect(blocked.reason).not.toBe(superseded.reason);
  });

  it("reports reason 'redirect-loop' for a redirect cycle", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/login", redirect: "/dashboard" },
      { path: "/dashboard", redirect: "/login" },
    ]);

    const result = await navigate("/login");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("redirect-loop");
  });

  it("reports reason 'unsafe-target' for a blocked URI scheme", async () => {
    setRoutes([{ path: "/", component: el("home") }]);

    const result = await navigate("javascript:alert(1)");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("unsafe-target");
  });

  it("reports reason 'unsafe-target' for an absolute open-redirect target", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/out", redirect: "https://evil.example.com" },
    ]);

    const result = await navigate("/out");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.reason).toBe("unsafe-target");
  });

  it("reports reason 'duplicate' for an identical repeat navigation", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", component: el("a") },
    ]);

    await navigate("/a");
    const result = await navigate("/a");

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.type).toBe("duplicated");
    expect(result.reason).toBe("duplicate");
  });

  it("keeps the legacy `type` field stable for existing callers", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/blocked", component: el("blocked"), beforeEnter: () => false },
      { path: "/ok", component: el("ok") },
    ]);

    // Pre-existing code branching only on `type` must behave as before.
    const blocked = await navigate("/blocked");
    expect(blocked.success).toBe(false);
    if (blocked.success) throw new Error("unreachable");
    expect(blocked.type).toBe("aborted");
    expect(blocked.failure.from).toBeDefined();
    expect(blocked.failure.to).toBeDefined();

    const ok = await navigate("/ok");
    expect(ok.success).toBe(true);
    if (!ok.success) throw new Error("unreachable");
    expect(ok.route.path).toBe("/ok");
  });
});

describe("router hardening: RouterLink respects preventDefault", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/users", component: el("users") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("does not navigate when an earlier handler prevented the default", async () => {
    const { RouterLink } = await import("../src/plugins/router");
    const link = RouterLink({ to: "/users", nodes: "Users" }) as HTMLAnchorElement;
    document.body.appendChild(link);

    // Capture phase, so this runs before the router's own bubble listener.
    link.addEventListener("click", (e) => e.preventDefault(), true);

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    expect(route().path).not.toBe("/users");
    link.remove();
  });

  it("still navigates for an ordinary click", async () => {
    const { RouterLink } = await import("../src/plugins/router");
    const link = RouterLink({ to: "/users", nodes: "Users" }) as HTMLAnchorElement;
    document.body.appendChild(link);

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    expect(route().path).toBe("/users");
    link.remove();
  });
});
