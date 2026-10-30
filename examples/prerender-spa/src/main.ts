import { div, footer, header, nav } from "sibujs";
import { createRouter, Route, RouterLink, routerReady } from "sibujs/plugins";
import { hydrate } from "sibujs/ssr";
import { routes } from "./routes";

createRouter(routes, {
  mode: "history",
  head: {
    title: "Wraps Studio",
    titleTemplate: "%s · Wraps Studio",
    og: { siteName: "Wraps Studio", type: "website" },
  },
});

const App = () =>
  div({ class: "app" }, [
    header([
      nav([
        RouterLink({ to: "/" }, "Home"),
        RouterLink({ to: "/cotizar" }, "Get a quote"),
        RouterLink({ to: "/galeria" }, "Gallery"),
      ]),
    ]),
    Route(),
    footer("Wraps Studio"),
  ]);

// On a pre-rendered page the client takes over with hydrate(): it builds the
// app and replaces the static markup in one swap. Waiting for the router first
// means every route component (lazy chunks included) is already loaded, so the
// swap never shows an empty outlet. With no pre-rendered markup (a route served
// from the 200.html shell) the same call simply renders.
routerReady().then(() => hydrate(App, document.getElementById("app") as HTMLElement));
