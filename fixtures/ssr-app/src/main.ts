// Client entry. A pre-rendered page is adopted (its nodes are reused); the
// shell of a browser-only route (no server content) is rendered fresh.
import { mount } from "../../../index";
import { createRouter, Route, routerReady } from "../../../plugins";
import { hydrate } from "../../../ssr";
import { head, routes } from "./routes";

// The static server serves `cotizar/index.html` at `/cotizar/`.
createRouter(routes, { mode: "history", head, trailingSlash: "ignore" });

const root = document.getElementById("app") as HTMLElement;
void routerReady().then(() => {
  if (root.hasChildNodes()) void hydrate(() => Route(), root, { strategy: "adopt" });
  else mount(() => Route() as unknown as HTMLElement, root);
});
