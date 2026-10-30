import { afterEach, describe, expect, it } from "vitest";
import { button, div, form, h1, input } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { hydrate } from "../src/platform/ssr";
import { createRouter, destroyRouter, navigate, Route, type RouteDef, routerReady } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// The client taking over a pre-rendered page: `await routerReady()` then
// `hydrate(App, root)` replaces the static markup with the live app in one
// swap, adopts the pre-rendered head tags instead of duplicating them, and
// from then on the head follows navigation.
// ---------------------------------------------------------------------------

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
};

afterEach(() => {
  destroyRouter();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

// What the pre-renderer wrote for /cotizar (trimmed to the parts that matter).
const PRERENDERED_HEAD =
  '<title data-sibu-base-title="Wraps Studio">Get a quote · Wraps Studio</title>' +
  '<meta name="description" content="Price in 24h" data-sibu-head="">' +
  '<meta property="og:title" content="Get a quote" data-sibu-head="">' +
  '<meta property="og:description" content="Price in 24h" data-sibu-head="">';
const PRERENDERED_BODY =
  '<div id="app" data-sibu-hydrated="true"><div class="app"><!--route-outlet-->' +
  '<div class="page quote"><h1>Get a quote</h1><form><input id="vehicle"><button type="submit">Send</button></form>' +
  '<div class="status"></div></div></div></div>';

const Quote = () => {
  const [sent, setSent] = signal(false);
  return div({ class: "page quote" }, [
    h1("Get a quote"),
    form(
      {
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            setSent(true);
          },
        },
      },
      [input({ id: "vehicle" }), button({ type: "submit" }, "Send")],
    ),
    div({ class: "status" }, () => (sent() ? "Thanks!" : "")),
  ]);
};

const routes: RouteDef[] = [
  {
    path: "/",
    component: () => div({ class: "page home" }, [h1("Home")]),
    head: { title: "Wraps", description: "Wraps for every vehicle" },
  },
  {
    path: "/cotizar",
    // Lazy, like a code-split route: routerReady() must wait for the chunk.
    lazy: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { default: Quote };
    },
    head: { title: "Get a quote", description: "Price in 24h" },
  },
];

describe("client takeover of a pre-rendered page", () => {
  it("swaps in the live app without an empty frame and without duplicating head tags", async () => {
    document.head.innerHTML = PRERENDERED_HEAD;
    document.body.innerHTML = PRERENDERED_BODY;
    history.replaceState(null, "", "/cotizar");
    const root = document.getElementById("app") as HTMLElement;
    const staticH1 = root.querySelector("h1");

    createRouter(routes, { mode: "history", head: { title: "Wraps Studio", titleTemplate: "%s · Wraps Studio" } });
    await routerReady();
    // Before the swap the pre-rendered page is untouched.
    expect(root.querySelector("h1")).toBe(staticH1);

    hydrate(() => div({ class: "app" }, [Route()]), root);
    // Microtasks only — no timer turn, so no frame could have been painted.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const liveH1 = root.querySelector("h1");
    expect(liveH1?.textContent).toBe("Get a quote");
    expect(liveH1).not.toBe(staticH1);

    expect(document.title).toBe("Get a quote · Wraps Studio");
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);

    // The page is live: the form's reactive status updates.
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(root.querySelector(".status")!.textContent).toBe("Thanks!");
  });

  it("then follows client-side navigation, and back restores the pre-rendered route's head", async () => {
    document.head.innerHTML = PRERENDERED_HEAD;
    document.body.innerHTML = PRERENDERED_BODY;
    history.replaceState(null, "", "/cotizar");
    const root = document.getElementById("app") as HTMLElement;
    createRouter(routes, { mode: "history", head: { title: "Wraps Studio", titleTemplate: "%s · Wraps Studio" } });
    await routerReady();
    hydrate(() => div({ class: "app" }, [Route()]), root);
    await settle();

    await navigate("/");
    await settle();
    expect(document.title).toBe("Wraps · Wraps Studio");
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      "Wraps for every vehicle",
    );
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe("Wraps");
    expect(root.querySelector("h1")?.textContent).toBe("Home");

    history.back();
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(location.pathname).toBe("/cotizar");
    expect(document.title).toBe("Get a quote · Wraps Studio");
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(root.querySelector("h1")?.textContent).toBe("Get a quote");
  });
});
