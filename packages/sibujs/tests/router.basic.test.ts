import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, destroyRouter, Route, RouterLink } from "../src/plugins/router";

// Minimal tag factory to match user's code
function div(props: { nodes?: any }): HTMLDivElement {
  const el = document.createElement("div");
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

describe("Router Bug Report: Route renders nothing", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
  });

  const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

  it("should render Home component on initial / path", async () => {
    function Home() {
      return div({ nodes: "Home page" });
    }

    function About() {
      return div({ nodes: "About page" });
    }

    function App() {
      createRouter(
        [
          { path: "/", component: Home },
          { path: "/about", component: About },
        ],
        { mode: "history" },
      );

      return div({
        nodes: [
          div({
            nodes: [RouterLink({ to: "/", nodes: "Home" }), RouterLink({ to: "/about", nodes: "About" })],
          }),
          Route(),
        ],
      });
    }

    const container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);

    mount(App, container);

    // Wait for microtasks + async loadComponent
    await wait(200);

    // Check that Route rendered the Home component
    const _routeOutlet = container.querySelector("div");
    console.log("Container innerHTML:", container.innerHTML);
    console.log("Container textContent:", container.textContent);

    expect(container.textContent).toContain("Home page");

    // Clean up
    document.body.removeChild(container);
  });

  it("should render About component after clicking About link", async () => {
    function Home() {
      return div({ nodes: "Home page" });
    }

    function About() {
      return div({ nodes: "About page" });
    }

    function App() {
      createRouter(
        [
          { path: "/", component: Home },
          { path: "/about", component: About },
        ],
        { mode: "history" },
      );

      return div({
        nodes: [
          div({
            nodes: [RouterLink({ to: "/", nodes: "Home" }), RouterLink({ to: "/about", nodes: "About" })],
          }),
          Route(),
        ],
      });
    }

    const container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);

    mount(App, container);
    await wait(200);

    // Verify initial render
    expect(container.textContent).toContain("Home page");

    // Click the About link
    const aboutLink = container.querySelectorAll("a")[1];
    expect(aboutLink).toBeTruthy();
    expect(aboutLink.textContent).toBe("About");

    aboutLink.click();
    await wait(200);

    console.log("After About click:", container.innerHTML);
    console.log("After About text:", container.textContent);

    expect(container.textContent).toContain("About page");

    document.body.removeChild(container);
  });
});
