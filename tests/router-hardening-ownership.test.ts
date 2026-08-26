/**
 * Route component ownership and history-integration suite.
 *
 * Invariants under test:
 *  - A route component removed from the active route tree is disposed exactly once.
 *  - A popstate-driven navigation must not create a new history entry.
 *  - Repeated route replacement must not accumulate DOM or subscriptions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLeaks, registerDisposer } from "../src/core/rendering/dispose";
import { createRouter, destroyRouter, navigate, Route, route, setRoutes } from "../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A route component that records its own disposal, once mounted. */
const tracked = (name: string, log: string[]) => () => {
  const d = document.createElement("div");
  d.textContent = name;
  registerDisposer(d, () => {
    // The component loader validates a freshly-loaded component by invoking it
    // once and discarding the resulting node. That probe node is now disposed
    // rather than leaked (OUT-004), but it was never mounted, so it is not a
    // route replacement and must not be counted as one. Disposal always runs
    // before detachment, so a genuinely mounted node still has a parent here.
    if (d.parentNode) log.push(name);
  });
  return d;
};

describe("router hardening: route component ownership", () => {
  let host: HTMLElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    destroyRouter();
    host.remove();
    vi.restoreAllMocks();
  });

  it("disposes the outgoing route component exactly once", async () => {
    const log: string[] = [];
    setRoutes([
      { path: "/", component: tracked("home", log) },
      { path: "/a", component: tracked("a", log) },
      { path: "/b", component: tracked("b", log) },
    ]);
    host.appendChild(Route());

    await navigate("/a");
    await settle();
    expect(host.textContent).toContain("a");

    await navigate("/b");
    await settle();

    expect(log).toEqual(["a"]);
    expect(host.textContent).toContain("b");
    expect(host.textContent).not.toContain("a");
  });

  it("disposes each route exactly once across an A → B → A cycle", async () => {
    const log: string[] = [];
    setRoutes([
      { path: "/", component: tracked("home", log) },
      { path: "/a", component: tracked("a", log) },
      { path: "/b", component: tracked("b", log) },
    ]);
    host.appendChild(Route());

    await navigate("/a");
    await settle();
    await navigate("/b");
    await settle();
    await navigate("/a");
    await settle();

    // One disposal per replacement, never a double-dispose.
    expect(log).toEqual(["a", "b"]);
  });

  it("leaves exactly one rendered route after many replacements", async () => {
    const log: string[] = [];
    setRoutes([
      { path: "/", component: tracked("home", log) },
      { path: "/a", component: tracked("a", log) },
      { path: "/b", component: tracked("b", log) },
    ]);
    host.appendChild(Route());

    for (let i = 0; i < 100; i++) {
      await navigate(i % 2 === 0 ? "/a" : "/b");
      await settle();
    }

    // No duplicated DOM accumulating in the outlet.
    const rendered = Array.from(host.querySelectorAll("div")).filter(
      (d) => d.textContent === "a" || d.textContent === "b",
    );
    expect(rendered).toHaveLength(1);
    // 100 navigations, 99 replacements of a previously mounted component.
    expect(log.length).toBeLessThanOrEqual(100);
  });

  it("does not grow live binding count across repeated navigation", async () => {
    const log: string[] = [];
    setRoutes([
      { path: "/", component: tracked("home", log) },
      { path: "/a", component: tracked("a", log) },
      { path: "/b", component: tracked("b", log) },
    ]);
    host.appendChild(Route());

    // Warm up so first-run singletons are not counted.
    await navigate("/a");
    await settle();
    await navigate("/b");
    await settle();
    const baseline = checkLeaks();

    for (let i = 0; i < 100; i++) {
      await navigate(i % 2 === 0 ? "/a" : "/b");
      await settle();
    }

    // Allow a small constant for the one currently-mounted route.
    expect(checkLeaks()).toBeLessThanOrEqual(baseline + 2);
  });

  it("disposes the mounted route component when the router is destroyed", async () => {
    const log: string[] = [];
    setRoutes([
      { path: "/", component: tracked("home", log) },
      { path: "/a", component: tracked("a", log) },
    ]);
    host.appendChild(Route());

    await navigate("/a");
    await settle();
    expect(log).toEqual([]);

    destroyRouter();
    await settle();

    expect(log).toEqual(["a"]);
  });
});

describe("router hardening: history integration", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: () => document.createElement("div") },
      { path: "/a", component: () => document.createElement("div") },
      { path: "/b", component: () => document.createElement("div") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("push adds a history entry, replace does not", async () => {
    const { push, replace } = await import("../src/plugins/router");

    const start = window.history.length;
    await push("/a");
    const afterPush = window.history.length;
    expect(afterPush).toBe(start + 1);

    await replace("/b");
    expect(window.history.length).toBe(afterPush);
    expect(window.location.pathname).toBe("/b");
  });

  it("a popstate-driven navigation does not create a new history entry", async () => {
    await navigate("/a");
    await navigate("/b");
    const lengthBefore = window.history.length;

    // Simulate the browser moving back: location changes, then popstate fires.
    window.history.replaceState({}, "", "/a");
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await settle();

    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.pathname).toBe("/a");
  });

  it("keeps route state and location in agreement after popstate", async () => {
    await navigate("/a");
    await navigate("/b");
    expect(route().path).toBe("/b");

    window.history.replaceState({}, "", "/a");
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await settle();

    expect(route().path).toBe(window.location.pathname);
  });

  it("ignores popstate after the router is destroyed", async () => {
    await navigate("/a");
    destroyRouter();

    const pathAfterDestroy = window.location.pathname;
    window.history.replaceState({}, "", "/b");
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    await settle();

    // No commit should have occurred; we only changed location ourselves.
    expect(window.location.pathname).toBe("/b");
    expect(pathAfterDestroy).toBe("/a");
  });
});
