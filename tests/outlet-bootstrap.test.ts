import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import {
  beforeEach as beforeEachGuard,
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  type NavigationNext,
  navigate,
  Outlet,
  Route,
  type RouteDef,
} from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Until its first navigation resolves, a router holds a placeholder route.
// An outlet that renders nothing for it has no outcome yet — but when the
// navigation that would replace it is cancelled by a guard (and none other is
// in flight), the placeholder IS the outcome: the outlet must settle then,
// not wait for the enter's deadline. A navigation still pending (a newer one,
// or a guard that never answers) keeps it pending.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// No route for "/": the placeholder matches nothing.
const routes: RouteDef[] = [
  { path: "/admin", name: "admin", component: () => div({ class: "page-admin" }, "admin") },
  { path: "/login", name: "login", component: () => div({ class: "page-login" }, "login") },
  { path: "/slow", name: "slow", component: () => div({ class: "page-slow" }, "slow") },
];

/**
 * Create the router at `/admin`, register `guard`, and mount
 * `when(on, () => Fragment([heading, outlet()]))` with a custom enter — before
 * the initial navigation runs, so the outlet's first pass sees the placeholder.
 */
function mount(guard: (to: string, next: NavigationNext) => void, outlet: () => Node = Route, budget = 2000) {
  createRouter(routes, { mode: "memory", url: "/admin" });
  beforeEachGuard((to, _from, next) => guard(to.path, next));
  const [on] = signal(true);
  const seen: (Element | null)[] = [];
  const enter = vi.fn(() => {
    seen.push(host.querySelector("[class^='page-']"));
  });
  // The first render enters (`appear`): it runs in the same turn as the
  // initial navigation, so the outlet's first pass sees the placeholder.
  host.appendChild(
    when(on, () => Fragment([span({ class: "heading" }, "h"), outlet()]), {
      transition: { enter, appear: true, waitForContent: budget },
    }),
  );
  return { enter, seen };
}

describe("a guard cancelling the initial navigation settles the outlet", () => {
  it("synchronously (Route)", async () => {
    const { enter } = mount((_to, next) => next(false));
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".page-admin")).toBeNull();
  });

  it("asynchronously (Route)", async () => {
    let answer!: NavigationNext;
    const { enter } = mount((_to, next) => {
      answer = next;
    });
    await flush();
    expect(enter).not.toHaveBeenCalled();
    answer(false);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("KeepAliveRoute", async () => {
    const { enter } = mount(
      (_to, next) => next(false),
      () => KeepAliveRoute(),
    );
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("Outlet", async () => {
    const { enter } = mount((_to, next) => next(false), Outlet);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });
});

describe("outcomes other than a cancellation", () => {
  it("a guard redirect settles on the page it redirected to", async () => {
    const { enter, seen } = mount((to, next) => next(to === "/admin" ? "/login" : true));
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]?.className).toBe("page-login");
  });

  it("a superseded initial navigation does not settle it while the newer one is pending", async () => {
    const answers = new Map<string, NavigationNext>();
    const { enter } = mount((to, next) => {
      answers.set(to, next);
    });
    await flush();
    // A newer navigation supersedes the initial one, whose guard never answers.
    void navigate("/slow");
    await flush();
    expect(answers.has("/slow")).toBe(true);
    expect(enter).not.toHaveBeenCalled();
    // The newer one is cancelled too: now no navigation is in flight.
    answers.get("/slow")?.(false);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a guard that never answers is bounded by the enter's own deadline", async () => {
    const { enter } = mount(() => {}, Route, 150);
    await sleep(40);
    expect(enter).not.toHaveBeenCalled();
    await sleep(400);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("an allowed navigation settles on its page, not on the placeholder", async () => {
    const { enter, seen } = mount((_to, next) => next(true));
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]?.className).toBe("page-admin");
  });
});
