/**
 * `scrollBehavior` regression suite — the DOM half of MEM-001.
 *
 * The DOM-less half lives in `router-domless.test.ts`, which runs under the
 * `node` environment and asserts that a configured `scrollBehavior` is silently
 * skipped rather than failing the navigation. This file asserts the other
 * direction: where the browser primitives genuinely exist, scrolling still
 * happens exactly as before the guard was added.
 *
 * Both `requestAnimationFrame` and `window.scrollTo` are stubbed rather than
 * observed, because jsdom's rAF is asynchronous (and absent unless the
 * environment opts into `pretendToBeVisual`), which would make the assertion
 * depend on timer scheduling instead of on router behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter } from "../src/plugins/router";

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Both primitives are addressed through an index-signature view of the globals
 * rather than their `lib.dom` types: the point of these tests is to install
 * stand-ins and to remove them entirely, neither of which the real signatures
 * permit.
 */
const globals = globalThis as unknown as Record<string, unknown>;
const win = window as unknown as Record<string, unknown>;

describe("router scrollBehavior in a DOM environment", () => {
  let rafCalls: number;
  let scrollCalls: [number, number][];
  let originalRaf: unknown;
  let originalScrollTo: unknown;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    rafCalls = 0;
    scrollCalls = [];

    originalRaf = globals.requestAnimationFrame;
    originalScrollTo = win.scrollTo;

    // Run the frame callback synchronously so the assertion is about the
    // router, not about when the browser decides to paint.
    globals.requestAnimationFrame = (cb: () => void) => {
      rafCalls++;
      cb();
      return 1;
    };
    win.scrollTo = (x: number, y: number) => {
      scrollCalls.push([x, y]);
    };
  });

  afterEach(() => {
    destroyRouter();
    if (originalRaf === undefined) delete globals.requestAnimationFrame;
    else globals.requestAnimationFrame = originalRaf;
    if (originalScrollTo !== undefined) win.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
  });

  it("still calls requestAnimationFrame and window.scrollTo on navigation", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: () => document.createElement("div") },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 0, y: 0 }) },
    );
    await flush();

    rafCalls = 0;
    scrollCalls = [];

    const result = await router.push("/a");
    await flush();

    expect(result.success).toBe(true);
    expect(rafCalls).toBe(1);
    expect(scrollCalls).toEqual([[0, 0]]);
  });

  it("passes the hook's coordinates through unchanged", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/deep", component: () => document.createElement("div") },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 12, y: 340 }) },
    );
    await flush();
    scrollCalls = [];

    await router.push("/deep");
    await flush();

    expect(scrollCalls).toEqual([[12, 340]]);
  });

  it("receives the to/from route contexts", async () => {
    const seen: [string, string][] = [];
    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: () => document.createElement("div") },
        { path: "/b", component: () => document.createElement("div") },
      ],
      {
        mode: "history",
        scrollBehavior: (to, from) => {
          seen.push([to.path, from.path]);
          return { x: 0, y: 0 };
        },
      },
    );
    await flush();
    seen.length = 0;

    await router.push("/a");
    await flush();
    await router.push("/b");
    await flush();

    expect(seen).toContainEqual(["/a", "/"]);
    expect(seen).toContainEqual(["/b", "/a"]);
  });

  it("does not scroll when the hook declines", async () => {
    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: () => document.createElement("div") },
      ],
      { mode: "history", scrollBehavior: () => null },
    );
    await flush();
    rafCalls = 0;
    scrollCalls = [];

    await router.push("/a");
    await flush();

    expect(rafCalls).toBe(0);
    expect(scrollCalls).toEqual([]);
  });

  it("skips scrolling — but still navigates — when scrollTo is unavailable", async () => {
    // A partial DOM shim: a document and a window exist, but scrolling does not.
    // Guarding on `typeof window !== "undefined"` alone would have thrown here.
    delete win.scrollTo;

    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: () => document.createElement("div") },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 0, y: 50 }) },
    );
    await flush();

    const result = await router.push("/a");
    await flush();

    expect(result.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");
    expect(rafCalls).toBe(0);
  });

  it("skips scrolling — but still navigates — when requestAnimationFrame is unavailable", async () => {
    delete globals.requestAnimationFrame;

    const router = createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: () => document.createElement("div") },
      ],
      { mode: "history", scrollBehavior: () => ({ x: 0, y: 50 }) },
    );
    await flush();

    const result = await router.push("/a");
    await flush();

    expect(result.success).toBe(true);
    expect(router.currentRoute.path).toBe("/a");
    expect(scrollCalls).toEqual([]);
  });
});
