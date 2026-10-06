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
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { when } from "../../src/core/rendering/directives";
import { div } from "../../src/core/rendering/html";
import { mount } from "../../src/core/rendering/mount";
import { signal } from "../../src/core/signals/signal";
import { createRouter, destroyRouter, KeepAliveRoute, navigate, Route, type RouteDef } from "../../src/plugins/router";

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
