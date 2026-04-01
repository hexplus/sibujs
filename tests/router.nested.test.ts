import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, destroyRouter, navigate, Outlet, Route, route } from "../src/plugins/router";

function div(props: { nodes?: any; class?: string; id?: string }): HTMLDivElement {
  const el = document.createElement("div");
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.nodes != null) {
    if (typeof props.nodes === "string") {
      el.textContent = props.nodes;
    } else if (props.nodes instanceof Node) {
      el.appendChild(props.nodes);
    } else if (Array.isArray(props.nodes)) {
      for (const child of props.nodes) {
        if (typeof child === "string") {
          el.appendChild(document.createTextNode(child));
        } else if (child instanceof Node) {
          el.appendChild(child);
        }
      }
    }
  }
  return el;
}

function mount(component: () => Element, container: Element) {
  const node = component();
  container.appendChild(node);
  return node;
}

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe("Nested Routes with Outlet", () => {
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

  it("should render parent layout with child via Outlet", async () => {
    function Layout() {
      return div({
        id: "layout",
        nodes: [div({ nodes: "Sidebar" }), Outlet()],
      });
    }

    function ChildA() {
      return div({ nodes: "Child A content" });
    }

    function ChildB() {
      return div({ nodes: "Child B content" });
    }

    function App() {
      createRouter(
        [
          {
            path: "/parent",
            component: Layout,
            children: [
              { path: "/a", component: ChildA },
              { path: "/b", component: ChildB },
            ],
          },
        ],
        { mode: "history" },
      );
      return div({ nodes: Route() });
    }

    window.history.replaceState({}, "", "/parent/a");
    mount(App, container);
    await wait(300);

    expect(container.textContent).toContain("Sidebar");
    expect(container.textContent).toContain("Child A content");
  });

  it("should switch child routes without destroying parent layout", async () => {
    let layoutCreateCount = 0;

    function Layout() {
      layoutCreateCount++;
      return div({
        id: "layout",
        nodes: [div({ nodes: "Layout" }), Outlet()],
      });
    }

    function ChildA() {
      return div({ nodes: "Page A" });
    }

    function ChildB() {
      return div({ nodes: "Page B" });
    }

    function App() {
      createRouter(
        [
          {
            path: "/app",
            component: Layout,
            children: [
              { path: "/a", component: ChildA },
              { path: "/b", component: ChildB },
            ],
          },
        ],
        { mode: "history" },
      );
      return div({ nodes: Route() });
    }

    window.history.replaceState({}, "", "/app/a");
    mount(App, container);
    await wait(300);

    expect(container.textContent).toContain("Page A");
    const countAfterInitial = layoutCreateCount;

    // Navigate to sibling child route
    await navigate("/app/b");
    await wait(300);

    expect(container.textContent).toContain("Page B");
    expect(container.textContent).not.toContain("Page A");
    // Parent layout should NOT have been re-created when switching children
    expect(layoutCreateCount).toBe(countAfterInitial);
  });

  it("should have correct matched array with parent chain", async () => {
    let capturedMatched: any[] = [];

    function Layout() {
      return div({ nodes: [div({ nodes: "Layout" }), Outlet()] });
    }

    function Child() {
      capturedMatched = route().matched;
      return div({ nodes: "Child" });
    }

    function App() {
      createRouter(
        [
          {
            path: "/section",
            component: Layout,
            children: [{ path: "/page", component: Child }],
          },
        ],
        { mode: "history" },
      );
      return div({ nodes: Route() });
    }

    window.history.replaceState({}, "", "/section/page");
    mount(App, container);
    await wait(300);

    expect(capturedMatched.length).toBe(2);
    expect(capturedMatched[0].path).toBe("/section");
    expect(capturedMatched[1].path).toBe("/page");
  });

  it("should render index child route (empty path)", async () => {
    function Layout() {
      return div({ nodes: [div({ nodes: "Nav" }), Outlet()] });
    }

    function Index() {
      return div({ nodes: "Index page" });
    }

    function Detail() {
      return div({ nodes: "Detail page" });
    }

    function App() {
      createRouter(
        [
          {
            path: "/docs",
            component: Layout,
            children: [
              { path: "", component: Index },
              { path: "/detail", component: Detail },
            ],
          },
        ],
        { mode: "history" },
      );
      return div({ nodes: Route() });
    }

    window.history.replaceState({}, "", "/docs");
    mount(App, container);
    await wait(300);

    expect(container.textContent).toContain("Nav");
    expect(container.textContent).toContain("Index page");
  });
});
