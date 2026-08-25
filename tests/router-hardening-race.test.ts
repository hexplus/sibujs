/**
 * Router navigation-ownership regression suite.
 *
 * The governing invariant:
 *
 *   Only the currently active navigation may commit router state.
 *
 * Every test here drives a superseded navigation to completion *after* a newer
 * one has already committed, and asserts the stale navigation changed nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter, navigate, route, setRoutes } from "../src/plugins/router";

/** A promise whose settlement the test controls, so orderings are exact. */
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

describe("router hardening: only the active navigation may commit", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("a slow beforeEnter guard must not commit after a newer navigation wins", async () => {
    const gate = deferred<boolean>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    // A starts and parks inside its beforeEnter guard.
    const slowNav = navigate("/slow");
    await settle();

    // B supersedes A and commits.
    await navigate("/fast");
    expect(route().path).toBe("/fast");
    expect(window.location.pathname).toBe("/fast");

    // A's guard finally allows — but A is stale and must not commit.
    gate.resolve(true);
    await slowNav;
    await settle();

    expect(route().path).toBe("/fast");
    expect(window.location.pathname).toBe("/fast");
  });

  it("a stale navigation must not push a history entry", async () => {
    const gate = deferred<boolean>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    const slowNav = navigate("/slow");
    await settle();
    await navigate("/fast");

    const lengthAfterFast = window.history.length;

    gate.resolve(true);
    await slowNav;
    await settle();

    expect(window.history.length).toBe(lengthAfterFast);
    expect(window.location.pathname).toBe("/fast");
  });

  it("a stale navigation must not run afterEach hooks", async () => {
    const gate = deferred<boolean>();
    const seen: string[] = [];

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    const { afterEach: routerAfterEach } = await import("../src/plugins/router");
    const off = routerAfterEach((to) => {
      seen.push(to.path);
    });

    const slowNav = navigate("/slow");
    await settle();
    await navigate("/fast");

    seen.length = 0;

    gate.resolve(true);
    await slowNav;
    await settle();

    // The superseded navigation must not fire commit-only hooks.
    expect(seen).not.toContain("/slow");
    off();
  });

  it("a stale navigation must not apply its scroll position", async () => {
    const gate = deferred<boolean>();
    const scrollFor: string[] = [];

    destroyRouter();
    window.history.replaceState({}, "", "/");
    createRouter({
      mode: "history",
      base: "",
      scrollBehavior: (to) => {
        scrollFor.push(to.path);
        return { x: 0, y: 0 };
      },
    });

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
      { path: "/fast", component: el("fast") },
    ]);

    const slowNav = navigate("/slow");
    await settle();
    await navigate("/fast");

    scrollFor.length = 0;

    gate.resolve(true);
    await slowNav;
    await settle();

    expect(scrollFor).not.toContain("/slow");
  });

  it("latest-wins across three overlapping navigations", async () => {
    const g1 = deferred<boolean>();
    const g2 = deferred<boolean>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/one", component: el("one"), beforeEnter: () => g1.promise },
      { path: "/two", component: el("two"), beforeEnter: () => g2.promise },
      { path: "/three", component: el("three") },
    ]);

    const n1 = navigate("/one");
    await settle();
    const n2 = navigate("/two");
    await settle();
    await navigate("/three");

    expect(route().path).toBe("/three");

    // Both older navigations resolve late, in reverse order.
    g2.resolve(true);
    await settle();
    g1.resolve(true);
    await Promise.allSettled([n1, n2]);
    await settle();

    expect(route().path).toBe("/three");
    expect(window.location.pathname).toBe("/three");
  });

  it("a destroyed router must not commit a pending navigation", async () => {
    const gate = deferred<boolean>();

    setRoutes([
      { path: "/", component: el("home") },
      { path: "/slow", component: el("slow"), beforeEnter: () => gate.promise },
    ]);

    const slowNav = navigate("/slow");
    await settle();

    destroyRouter();
    const pathAtDestroy = window.location.pathname;

    gate.resolve(true);
    await Promise.allSettled([slowNav]);
    await settle();

    expect(window.location.pathname).toBe(pathAtDestroy);
  });
});
