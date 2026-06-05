import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { div, main as mainTag, a as aTag, span } from "../src/core/rendering/html";
import { mount } from "../src/core/rendering/mount";
import { createRouter, destroyRouter, lazy, navigate, Outlet, Route, route } from "../src/plugins/router";

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe("Navigating from a nested child route to a top-level route", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    document.body.removeChild(container);
  });

  it("swaps the outlet content (faithful to sibujs-web structure)", async () => {
    // A nav with reactive active-link styling — mirrors Navbar/NavLink, which
    // adds many reactive route() readers alongside the Route outlet.
    function NavLink(href: string) {
      return aTag(
        {
          href,
          class: () => (route().path.startsWith(href) ? "active" : "inactive"),
          on: {
            click: (e: Event) => {
              e.preventDefault();
              navigate(href);
            },
          },
        },
        href,
      );
    }

    // Nested layout with its own reactive route() readers (mirrors PathSidebar).
    function UILayout(content: Node) {
      return div("ui-layout", [
        div("ui-sidebar", [
          aTag({ href: "/ui/button", class: () => (route().path === "/ui/button" ? "on" : "off") }, "Button link"),
          span(() => `current: ${route().path}`),
        ]),
        div("ui-content", content),
      ]);
    }
    function UIWrapper() {
      return UILayout(Outlet());
    }

    const delayed = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
    const ButtonPage = lazy(() => delayed({ default: () => div("page", "Button page content") }, 40));
    const Features = lazy(() => delayed({ default: () => div("page", "Features page content") }, 40));

    function App() {
      createRouter(
        [
          { path: "/features", component: Features },
          {
            path: "/ui",
            component: UIWrapper,
            children: [{ path: "/button", component: ButtonPage }],
          },
        ],
        { mode: "history" },
      );
      return div("app", [
        div("nav", [NavLink("/features"), NavLink("/ui")]),
        mainTag({ class: "main" }, Route()),
      ]);
    }

    window.history.replaceState({}, "", "/ui/button");
    mount(App, container);
    await wait(350);

    const mainEl = container.querySelector(".main") as HTMLElement;
    expect(mainEl.textContent).toContain("Button page content");
    expect(mainEl.querySelector(".ui-sidebar")).toBeTruthy();

    // Leave the nested route for a top-level sibling. The Route outlet must
    // swap the whole nested layout (sidebar + Outlet child) for the new page.
    await navigate("/features");
    await wait(350);

    expect(mainEl.textContent).toContain("Features page content");
    expect(mainEl.textContent).not.toContain("Button page content");
    expect(mainEl.querySelector(".ui-sidebar")).toBeNull();
  });

  it("survives a rapid burst of navigations without wedging (latest wins)", async () => {
    function UILayout(content: Node) {
      return div("ui-layout", [div("ui-sidebar", "sidebar"), div("ui-content", content)]);
    }
    function UIWrapper() {
      return UILayout(Outlet());
    }
    const delayed = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
    const ButtonPage = lazy(() => delayed({ default: () => div("page", "Button page content") }, 30));
    const Features = lazy(() => delayed({ default: () => div("page", "Features page content") }, 30));
    const Learn = lazy(() => delayed({ default: () => div("page", "Learn page content") }, 30));

    function App() {
      createRouter(
        [
          { path: "/features", component: Features },
          { path: "/learn", component: Learn },
          { path: "/ui", component: UIWrapper, children: [{ path: "/button", component: ButtonPage }] },
        ],
        { mode: "history" },
      );
      return div("app", mainTag({ class: "main" }, Route()));
    }

    window.history.replaceState({}, "", "/ui/button");
    mount(App, container);
    await wait(200);

    const mainEl = container.querySelector(".main") as HTMLElement;

    // Fire several navigations before any of them settle. The last one wins.
    navigate("/features");
    navigate("/ui/button");
    navigate("/learn");
    await wait(400);

    expect(mainEl.textContent).toContain("Learn page content");
    expect(mainEl.textContent).not.toContain("Features page content");
    expect(mainEl.querySelector(".ui-sidebar")).toBeNull();

    // And the outlet is not wedged — a further navigation still renders.
    await navigate("/features");
    await wait(300);
    expect(mainEl.textContent).toContain("Features page content");
  });
});
