// @vitest-environment node
//
// Router construction in a genuinely DOM-less runtime.
//
// The rest of the router suite runs under jsdom, where `window` always exists —
// which is precisely why RC-001 survived every prior router hardening pass. This
// file deliberately opts into the `node` environment so `window` is truly
// undefined, matching bare Node / an SSR request / a DOM-less edge runtime.
//
// RC-001: `SibuRouter.initialize()` guards its event-listener registration with
// `typeof window !== "undefined"` (explicitly so SSR construction is safe), but
// the `queueMicrotask` bootstrap immediately below it was unguarded. It called
// `getCurrentPath()`, which read `window.location` bare. The constructor returned
// normally and then the process died from a microtask — an *uncatchable*
// ReferenceError that no `try`/`catch` around the call site could defend against.
// `createMemoryRouter`, documented for "testing/SSR", was affected in hash mode.
import { describe, expect, it } from "vitest";
import { createMemoryRouter, createRouter, destroyRouter } from "../src/plugins/router";

const flushBootstrap = () => new Promise((r) => setTimeout(r, 0));

describe("router construction without a DOM", () => {
  it("has no window in this environment (guards the test's own premise)", () => {
    expect(typeof window).toBe("undefined");
  });

  it("createRouter does not crash the process from its microtask bootstrap", async () => {
    const router = createRouter([{ path: "/", component: () => null as never }]);
    // Before the fix this rejected the whole file with an uncaught
    // `ReferenceError: window is not defined` thrown from queueMicrotask.
    await flushBootstrap();
    expect(router).toBeTruthy();
    destroyRouter();
  });

  it("createMemoryRouter (documented for testing/SSR) survives bootstrap", async () => {
    const { router, currentPath } = createMemoryRouter([{ path: "/", component: () => null as never }], "/");
    await flushBootstrap();
    expect(router).toBeTruthy();
    expect(currentPath()).toBe("/");
    destroyRouter();
  });

  it("resolves the DOM-less location to the root path and becomes ready", async () => {
    const router = createRouter([
      { path: "/", component: () => null as never },
      { path: "/other", component: () => null as never },
    ]);
    await flushBootstrap();
    expect(router.currentRoute.path).toBe("/");
    expect(router.isReady).toBe(true);
    destroyRouter();
  });

  it("registers no window listeners when there is no window to register on", async () => {
    // The listener guard was already correct; this pins it so a future refactor
    // of `initialize()` cannot regress it alongside the bootstrap fix.
    const router = createRouter([{ path: "/", component: () => null as never }], { mode: "history" });
    await flushBootstrap();
    expect(() => destroyRouter()).not.toThrow();
    expect(router).toBeTruthy();
  });
});
