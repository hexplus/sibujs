/**
 * Repeated query keys survive navigation.
 *
 * Invariants under test:
 *  - `navigate()` writes every value of a repeated key to the URL, in order —
 *    for a string target, for a navigation object with an array value, and on
 *    the initial resolution of a URL the page was loaded with.
 *  - `route().queryAll` and `routerState().queryAll` hold every value;
 *    `route().query` keeps its last-value-wins shape.
 *  - Adding or removing one value of a multi-value filter is a real
 *    navigation, never a refused duplicate.
 *  - `RouterLink` exact-active compares every value.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildURL,
  createRouter,
  destroyRouter,
  navigate,
  Route,
  RouterLink,
  route,
  routerState,
} from "../../src/plugins/router";

const EXACT = "router-link-exact-active";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const stub = (label: string) => () => {
  const d = document.createElement("div");
  d.textContent = label;
  return d;
};

describe("router: repeated query keys", () => {
  let host: HTMLElement;

  const start = async (initial = "/") => {
    window.history.replaceState({}, "", initial);
    createRouter(
      [
        { path: "/", component: stub("home") },
        { path: "/queue", component: stub("queue") },
      ],
      { mode: "history" },
    );
    host.appendChild(Route());
    await settle();
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    destroyRouter();
    host.remove();
  });

  it("a string target keeps every value in the URL and in queryAll", async () => {
    await start();
    const r = await navigate("/queue?status=needs_review&status=revision_requested");
    expect(r.success).toBe(true);
    expect(window.location.search).toBe("?status=needs_review&status=revision_requested");
    expect(route().queryAll).toEqual({ status: ["needs_review", "revision_requested"] });
    expect(route().query).toEqual({ status: "revision_requested" });
    expect(routerState().queryAll()).toEqual({ status: ["needs_review", "revision_requested"] });
  });

  it("a navigation object with an array value repeats the key", async () => {
    await start();
    const r = await navigate({ path: "/queue", query: { status: ["needs_review", "revision_requested"], page: "2" } });
    expect(r.success).toBe(true);
    expect(window.location.search).toBe("?status=needs_review&status=revision_requested&page=2");
    expect(route().queryAll).toEqual({ status: ["needs_review", "revision_requested"], page: ["2"] });
  });

  it("an empty array emits no parameter", async () => {
    await start();
    expect(buildURL({ path: "/queue", query: { status: [] } })).toBe("/queue");
    expect(buildURL({ path: "/queue", query: { status: [], page: "1" } })).toBe("/queue?page=1");
  });

  it("the initial resolution keeps repeated keys of the loaded URL", async () => {
    await start("/queue?status=a&status=b");
    expect(window.location.search).toBe("?status=a&status=b");
    expect(route().queryAll).toEqual({ status: ["a", "b"] });
  });

  it("adding a value to a multi-value filter is not a duplicate navigation", async () => {
    await start();
    await navigate("/queue?status=b");
    const added = await navigate("/queue?status=a&status=b");
    expect(added.success).toBe(true);
    expect(window.location.search).toBe("?status=a&status=b");
    const removed = await navigate({ path: "/queue", query: { status: ["b"] } });
    expect(removed.success).toBe(true);
    expect(window.location.search).toBe("?status=b");
  });

  it("the same values with keys reordered is still a duplicate", async () => {
    await start();
    await navigate("/queue?status=a&page=1&status=b");
    const r = await navigate({ path: "/queue", query: { page: "1", status: ["a", "b"] } });
    expect(r).toMatchObject({ success: false, reason: "duplicate" });
  });

  it("RouterLink exact-active compares every value", async () => {
    await start();
    const link = RouterLink({ to: { path: "/queue", query: { status: ["a", "b"] } } });
    host.appendChild(link);
    await navigate("/queue?status=a&status=b");
    await settle();
    expect(link.className).toContain(EXACT);
    await navigate("/queue?status=b");
    await settle();
    expect(link.className).not.toContain(EXACT);
  });
});
