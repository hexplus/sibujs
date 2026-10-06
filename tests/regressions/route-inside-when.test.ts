/**
 * An outlet built before it is attached renders once it is attached.
 *
 * Invariants under test:
 *  - A `Route()` anchor created ahead of time and attached later — the
 *    `const page = Route(); when(() => ready(), () => page, …)` shape — renders
 *    the current route as soon as it is attached, not only after the next
 *    navigation.
 *  - The same holds when the anchor is attached inside a detached subtree that
 *    joins the document later, and for `KeepAliveRoute()`.
 *  - A `Route()` created before `createRouter()` renders once the router
 *    exists.
 *  - The shapes that already worked (outlet inside a prebuilt element, outlet
 *    built inside the branch factory) keep working.
 *  - A `Route()` pass that FAILS while detached — a lazy chunk that rejects, a
 *    component that throws — shows that original error once attached, exactly
 *    as an attached outlet would, and its Retry button still works. A
 *    navigation made after the failure wins over the held error.
 *  - A detached `Outlet()` whose child fails ends as an attached one does
 *    (nothing rendered, error logged) and still renders the next child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../../src/core/rendering/directives";
import { div } from "../../src/core/rendering/html";
import { mount } from "../../src/core/rendering/mount";
import { signal } from "../../src/core/signals/signal";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Outlet,
  Route,
  type RouteDef,
} from "../../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

function page(label: string) {
  return () => {
    const el = document.createElement("div");
    el.dataset.page = label;
    el.textContent = label;
    return el;
  };
}

const routes: RouteDef[] = [
  { path: "/", component: page("home") },
  { path: "/about", component: page("about") },
];

describe("router: an outlet attached after creation renders", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    host.remove();
  });

  const shown = () => host.querySelector("[data-page]")?.textContent ?? null;

  /** Flip `ready`, then navigate: the outlet must render before and after. */
  async function readyThenNavigate(setReady: (v: boolean) => void): Promise<(string | null)[]> {
    await settle();
    const before = shown();
    setReady(true);
    await settle();
    const ready = shown();
    await navigate("/about");
    await settle();
    return [before, ready, shown()];
  }

  it("a bare Route() built ahead of time as the when() branch", async () => {
    createRouter(routes, { mode: "history" });
    const [ready, setReady] = signal(false);
    const content = Route();
    mount(
      () =>
        div([
          when(
            () => ready(),
            () => content,
            () => div("loading"),
          ),
        ]),
      host,
    );
    expect(await readyThenNavigate(setReady)).toEqual([null, "home", "about"]);
  });

  it("a bare Route() attached inside a detached subtree that joins the document later", async () => {
    createRouter(routes, { mode: "history" });
    const outlet = Route();
    await settle();
    const shell = document.createElement("main");
    shell.appendChild(outlet);
    await settle();
    expect(shown()).toBe(null);
    host.appendChild(shell);
    await settle();
    expect(shown()).toBe("home");
  });

  it("a bare KeepAliveRoute() built ahead of time as the when() branch", async () => {
    createRouter(routes, { mode: "history" });
    const [ready, setReady] = signal(false);
    const content = KeepAliveRoute();
    mount(
      () =>
        div([
          when(
            () => ready(),
            () => content,
            () => div("loading"),
          ),
        ]),
      host,
    );
    expect(await readyThenNavigate(setReady)).toEqual([null, "home", "about"]);
  });

  it("a Route() created before createRouter()", async () => {
    const [ready, setReady] = signal(false);
    const content = div([Route()]);
    createRouter(routes, { mode: "history" });
    mount(
      () =>
        div([
          when(
            () => ready(),
            () => content,
            () => div("loading"),
          ),
        ]),
      host,
    );
    expect(await readyThenNavigate(setReady)).toEqual([null, "home", "about"]);
  });

  it("a prebuilt element containing Route() as the when() branch", async () => {
    createRouter(routes, { mode: "history" });
    const [ready, setReady] = signal(false);
    const content = div([Route()]);
    mount(
      () =>
        div([
          when(
            () => ready(),
            () => content,
            () => div("loading"),
          ),
        ]),
      host,
    );
    expect(await readyThenNavigate(setReady)).toEqual([null, "home", "about"]);
  });

  it("Route() built inside the when() branch factory", async () => {
    createRouter(routes, { mode: "history" });
    const [ready, setReady] = signal(false);
    mount(
      () =>
        div([
          when(
            () => ready(),
            () => div([Route()]),
            () => div("loading"),
          ),
        ]),
      host,
    );
    expect(await readyThenNavigate(setReady)).toEqual([null, "home", "about"]);
  });

  it("a disposed outlet that was waiting for a parent never renders", async () => {
    createRouter(routes, { mode: "history" });
    const outlet = Route();
    await settle();
    destroyRouter();
    host.appendChild(outlet);
    await settle();
    expect(shown()).toBe(null);
  });
});

describe("router: a detached outlet whose pass fails", () => {
  let host: HTMLDivElement;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    host.remove();
    consoleError.mockRestore();
  });

  const errorText = () => host.querySelector(".route-error-message")?.textContent ?? null;
  const shown = () => host.querySelector("[data-page]")?.textContent ?? null;
  // Fails in `loadPlan()`, which runs before the pass checks for a parent.
  const notAComponent = "not a component" as unknown as () => HTMLElement;

  it("a plan that fails to load while detached shows its error once attached", async () => {
    createRouter([{ path: "/", component: notAComponent }], { mode: "history" });
    // Created after the initial resolution, so a single pass fails: a second
    // pass inside `errorRetryDelay` would report "failed recently" instead,
    // attached or not.
    await settle();
    const outlet = Route();
    await settle();
    expect(consoleError).toHaveBeenCalled();
    host.appendChild(outlet);
    await settle();
    expect(errorText()).toMatch(/must be a function/);
  });

  it("an async component that rejects after its outlet was detached shows the error on re-attach, and Retry works", async () => {
    let broken = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    createRouter(
      [
        {
          path: "/",
          component: async () => {
            await gate;
            if (broken) throw new Error("render failed");
            return page("home")();
          },
        },
      ],
      { mode: "history" },
    );
    const outlet = Route();
    host.appendChild(outlet);
    await settle();
    host.removeChild(outlet);
    release();
    await settle();
    expect(errorText()).toBe(null);
    host.appendChild(outlet);
    await settle();
    expect(errorText()).toBe("render failed");

    broken = false;
    host.querySelector<HTMLButtonElement>(".route-error-retry")?.click();
    await settle();
    expect(errorText()).toBe(null);
    expect(shown()).toBe("home");
  });

  it("a navigation after a detached failure wins over the held error", async () => {
    createRouter(
      [
        { path: "/", component: notAComponent },
        { path: "/about", component: page("about") },
      ],
      { mode: "history" },
    );
    const outlet = Route();
    await settle();
    await navigate("/about");
    await settle();
    host.appendChild(outlet);
    await settle();
    expect(errorText()).toBe(null);
    expect(shown()).toBe("about");
  });

  it("a detached Outlet() whose child fails ends as an attached one does, and renders the next child", async () => {
    const [ready, setReady] = signal(false);
    createRouter(
      [
        {
          path: "/app",
          component: () => {
            const outlet = Outlet();
            return div([
              when(
                () => ready(),
                () => outlet,
              ),
            ]);
          },
          children: [
            { path: "/broken", component: notAComponent },
            { path: "/ok", component: page("ok") },
          ],
        },
      ],
      { mode: "history" },
    );
    host.appendChild(Route());
    await navigate("/app/broken");
    await settle();
    expect(consoleError).toHaveBeenCalled();
    setReady(true);
    await settle();
    expect(shown()).toBe(null);
    await navigate("/app/ok");
    await settle();
    expect(shown()).toBe("ok");
  });
});
