import { afterEach, describe, expect, it, vi } from "vitest";
import { div, p } from "../src/core/rendering/html";
import { query } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import type { RouteDef } from "../src/plugins/router";

// `renderRoute(routes, url, { timeout })` is ONE deadline for the request: the
// initial navigation (guards included), loading the matched components, then
// building and settling the page with whatever budget is left. A route that
// cannot render in time answers 503 `failure: "timeout"`; it never hangs.

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `renderRoute`, or `"hung"` when it has not answered within `ms` — the test never waits forever. */
async function bounded<T>(work: Promise<T>, ms = 3000): Promise<T | "hung"> {
  return Promise.race([work, delay(ms).then(() => "hung" as const)]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderRoute — one deadline for the whole request", () => {
  it("answers 503 when the initial lazy import never resolves", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: RouteDef[] = [{ path: "/", lazy: () => new Promise(() => {}) }];
    const r = await bounded(renderRoute(routes, "/", { timeout: 15 }));
    expect(r).not.toBe("hung");
    if (r === "hung") return;
    expect(r.status).toBe(503);
    expect(r.failure).toBe("timeout");
    expect(r.html).toBe("");
    expect(r.diagnostics.timedOut).toBe(true);
    expect(r.diagnostics.pending[0]).toMatch(/^route:components \(\d+ ms\)$/);
  });

  it("ignores a lazy import that resolves after the deadline: nothing renders or commits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const chunk = deferred<{ default: () => Element }>();
    const Page = vi.fn(() => p("late page"));
    const routes: RouteDef[] = [{ path: "/", lazy: () => chunk.promise }];
    const r = await bounded(renderRoute(routes, "/", { timeout: 20 }));
    if (r === "hung") throw new Error("renderRoute hung");
    expect(r.status).toBe(503);

    chunk.resolve({ default: Page });
    await delay(20);
    expect(Page).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("bounds a beforeEnter guard that never answers (guardTimeout does not cover beforeEnter)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: RouteDef[] = [
      { path: "/", component: () => p("home"), beforeEnter: () => new Promise<boolean>(() => {}) },
    ];
    const r = await bounded(renderRoute(routes, "/", { timeout: 30, router: { guardTimeout: 60_000 } }));
    if (r === "hung") throw new Error("renderRoute hung");
    expect(r.status).toBe(503);
    expect(r.failure).toBe("timeout");
    expect(r.diagnostics.pending[0]).toMatch(/^route:navigation/);
  });

  it("renders when a slow guard answers within the deadline, with the rest of the budget", async () => {
    const routes: RouteDef[] = [
      { path: "/", component: () => p("guarded home"), beforeEnter: () => delay(20).then(() => true) },
    ];
    const r = await renderRoute(routes, "/", { timeout: 2000 });
    expect(r.status).toBe(200);
    expect(r.html).toContain("guarded home");
    expect(r.diagnostics.timedOut).toBe(false);
  });

  it("gives data fetching only what navigation and loading left of the deadline", async () => {
    // Loading takes 200 ms of a 300 ms deadline; the page's data takes 200 ms
    // more. With a fresh 300 ms for settling, the data would arrive.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const Page = () => {
      const q = query("slow-data", async () => {
        await delay(200);
        return "loaded data";
      });
      return div([p(() => q.data() ?? "loading data")]);
    };
    const routes: RouteDef[] = [{ path: "/", lazy: () => delay(200).then(() => ({ default: Page })) }];
    const r = await bounded(renderRoute(routes, "/", { timeout: 300 }));
    if (r === "hung") throw new Error("renderRoute hung");
    expect(r.diagnostics.timedOut).toBe(true);
    expect(r.html).not.toContain("loaded data");
  });

  it("renders a lazy route that loads within the deadline", async () => {
    const routes: RouteDef[] = [{ path: "/", lazy: () => delay(5).then(() => ({ default: () => p("lazy home") })) }];
    const r = await renderRoute(routes, "/", { timeout: 2000 });
    expect(r.status).toBe(200);
    expect(r.failure).toBeNull();
    expect(r.html).toContain("lazy home");
    expect(r.diagnostics.timedOut).toBe(false);
  });

  it("keeps concurrent requests apart: one times out, the other renders", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: RouteDef[] = [
      { path: "/stuck", lazy: () => new Promise(() => {}) },
      { path: "/ok", lazy: () => delay(10).then(() => ({ default: () => p("ok page") })) },
    ];
    const [stuck, ok] = await Promise.all([
      bounded(renderRoute(routes, "/stuck", { timeout: 40 })),
      bounded(renderRoute(routes, "/ok", { timeout: 2000 })),
    ]);
    if (stuck === "hung" || ok === "hung") throw new Error("renderRoute hung");
    expect(stuck.status).toBe(503);
    expect(ok.status).toBe(200);
    expect(ok.html).toContain("ok page");
    expect(ok.route?.path).toBe("/ok");
  });

  it("keeps the other outcomes: redirect, rejected guard, failed lazy load, 404", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: RouteDef[] = [
      { path: "/", component: () => p("home") },
      { path: "/old", redirect: "/" },
      { path: "/private", component: () => p("secret"), beforeEnter: () => false },
      { path: "/broken", lazy: () => Promise.reject(new Error("chunk failed")) },
      { path: "*", component: () => p("not found") },
    ];
    const opts = { timeout: 2000 };
    expect((await renderRoute(routes, "/old", opts)).status).toBe(302);
    const denied = await renderRoute(routes, "/private", opts);
    expect([denied.status, denied.failure]).toEqual([403, "guard"]);
    expect((await renderRoute(routes, "/nope", opts)).status).toBe(404);
    // A failed load renders the outlet's route error, as before — not a timeout.
    const broken = await renderRoute(routes, "/broken", opts);
    expect([broken.status, broken.failure, broken.diagnostics.timedOut]).toEqual([200, null, false]);
    expect(broken.html).toContain('<p class="route-error-message">chunk failed</p>');
  });
});
