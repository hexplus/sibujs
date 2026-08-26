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

describe("router navigation without a DOM", () => {
  // NODE-001. RC-001 made *construction* safe in a DOM-less runtime, but every
  // navigation still threw: `updateHistory()` referenced the bare `history`
  // global rather than a guarded one, so `push()`/`replace()` failed with
  // `ReferenceError: history is not defined`.
  //
  // This made `createMemoryRouter` — whose own doc comment says it "creates a
  // router that doesn't interact with browser history", and which the codebase
  // advertises for testing/SSR — unusable for its stated purpose: it could be
  // constructed and then never navigated.
  //
  // Found by the Node support-matrix pass, not by the jsdom suite: vitest's
  // jsdom environment installs `history` as a real global, so the bare
  // reference resolves there. A consumer wiring up jsdom by hand (the
  // documented way to run SibuJS outside a browser) copies `window` and
  // friends but has no reason to copy `history`, and hits this immediately.

  it("createMemoryRouter can actually navigate", async () => {
    const { router, currentPath, push } = createMemoryRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/about", component: () => null as never },
      ],
      "/",
    );
    await flushBootstrap();
    expect(currentPath()).toBe("/");

    const result = await push("/about");
    await flushBootstrap();

    expect(result.success, `navigation failed: ${JSON.stringify(result)}`).toBe(true);
    expect(currentPath()).toBe("/about");
    expect(router.currentRoute.path).toBe("/about");
    destroyRouter();
  });

  it("push and replace both commit without a history global", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
        { path: "/b", component: () => null as never },
      ],
      { mode: "history" },
    );
    await flushBootstrap();

    const pushed = await router.push("/a");
    await flushBootstrap();
    expect(pushed.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");

    const replaced = await router.replace("/b");
    await flushBootstrap();
    expect(replaced.success).toBe(true);
    expect(router.currentRoute.path).toBe("/b");

    destroyRouter();
  });

  it("a redirect route resolves without a history global", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/target", component: () => null as never },
        { path: "/old", redirect: "/target" },
      ],
      { mode: "history" },
    );
    await flushBootstrap();

    await router.push("/old").catch(() => {});
    await flushBootstrap();

    expect(router.currentRoute.path).toBe("/target");
    destroyRouter();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MEM-001 — scrollBehavior must not reach browser primitives here
  //
  // `handleScrollBehavior()` ran `requestAnimationFrame(() => window.scrollTo())`
  // with no environment probe, while the history write directly above it *was*
  // guarded (NODE-001). A memory router advertised for testing/SSR could
  // therefore be configured with a perfectly legal option and then die on
  // `ReferenceError: requestAnimationFrame is not defined` on first navigation.
  //
  // Policy A, matching NODE-001: the route still commits; only the browser-only
  // scroll side effect is skipped.
  // ─────────────────────────────────────────────────────────────────────────

  it("has neither requestAnimationFrame nor scrollTo here (guards the premise)", () => {
    expect(typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame).toBe("undefined");
    expect(typeof window).toBe("undefined");
  });

  // Note on reachability: `createMemoryRouter(routes, initialPath)` takes no
  // options object, so `scrollBehavior` cannot be passed to it directly — it
  // builds a hash-mode router internally. The configuration that reaches
  // `handleScrollBehavior()` in a DOM-less runtime is therefore an explicit
  // `createRouter(routes, { scrollBehavior })` running server-side, which is the
  // same code path a memory router executes on every navigation.

  it("a DOM-less router with scrollBehavior navigates without reaching scroll APIs", async () => {
    const calls: Array<{ to: string; from: string }> = [];
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      {
        mode: "hash",
        scrollBehavior: (to, from) => {
          calls.push({ to: to.path, from: from.path });
          return { x: 0, y: 0 };
        },
      },
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();

    // Navigation succeeds; no ReferenceError escapes.
    expect(result.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");

    // The hook is not invoked at all: SibuJS knows it cannot scroll here, and a
    // browser-oriented callback has no reason to run when its result would be
    // discarded. See the dedicated reproducer below.
    expect(calls).toHaveLength(0);

    destroyRouter();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MEM-001 (completion) — the environment guard must precede the user callback
  //
  // The first MEM-001 fix guarded the framework's OWN use of
  // requestAnimationFrame/window.scrollTo, but left those guards *after* the
  // call to the user's scrollBehavior. A browser-oriented callback therefore
  // still ran in a DOM-less runtime, where dereferencing `window` throws before
  // any guard is reached — and it throws after the route has already committed.
  // ─────────────────────────────────────────────────────────────────────────

  it("does not invoke scrollBehavior when the runtime cannot scroll", async () => {
    const scrollBehavior = vi.fn(() => {
      throw new Error("scrollBehavior must not run without scrolling primitives");
    });

    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      { mode: "history", scrollBehavior },
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();

    expect(scrollBehavior).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");

    destroyRouter();
  });

  it("a scrollBehavior that reads window is never given the chance to throw", async () => {
    // The realistic shape of the bug: a perfectly ordinary browser callback,
    // running on a server, reaching for a global that is not there.
    const scrollBehavior = vi.fn(() => ({
      x: 0,
      y: (globalThis as { window?: { scrollY: number } }).window!.scrollY,
    }));

    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      { mode: "history", scrollBehavior },
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();

    expect(scrollBehavior).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");

    destroyRouter();
  });

  it("keeps the navigation result and committed route in agreement", async () => {
    // The forbidden state: route says "/a", result says failure.
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      {
        mode: "history",
        scrollBehavior: () => {
          throw new Error("scroll failure");
        },
      },
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();

    const committed = router.currentRoute.path === "/a";
    expect(committed).toBe(true);
    expect(result.success).toBe(true);

    destroyRouter();
  });

  it("a DOM-less router with scrollBehavior survives a redirect", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/target", component: () => null as never },
        { path: "/old", redirect: "/target" },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 0, y: 120 }) },
    );
    await flushBootstrap();

    await router.push("/old").catch(() => {});
    await flushBootstrap();

    expect(router.currentRoute.path).toBe("/target");
    destroyRouter();
  });

  it("a scrollBehavior hook that returns nothing is equally safe", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      { mode: "history", scrollBehavior: () => null },
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();
    expect(result.success).toBe(true);
    destroyRouter();
  });

  it("a memory router (no scrollBehavior available) is unaffected", async () => {
    const { router, currentPath } = createMemoryRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      "/",
    );
    await flushBootstrap();

    const result = await router.push("/a");
    await flushBootstrap();
    expect(result.success).toBe(true);
    expect(currentPath()).toBe("/a");
    destroyRouter();
  });

  it("destroying a scroll-configured DOM-less router is clean", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => null as never },
        { path: "/a", component: () => null as never },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 0, y: 40 }) },
    );
    await flushBootstrap();
    await router.push("/a");
    await flushBootstrap();

    expect(() => destroyRouter()).not.toThrow();
  });
});
