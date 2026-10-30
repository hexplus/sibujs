// Bundled by bench/ssr-takeover.mjs: the fixture landing page, server-rendered
// (with and without adoption markers) and taken over in a jsdom browser.
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { __resetQueryCache } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import { hydrate, renderToString } from "../src/platform/ssr";
import { createRouter, destroyRouter, Route, routerReady } from "../src/plugins/router";
import { __resetTransfer } from "../src/utils/transfer";

globalThis.fetch = createStubFetch();

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/** Server output of `/` in each marker mode. */
export async function renderModes(): Promise<{ legacy: string; plain: string; adopt: string; state: string }> {
  const plain = await renderRoute(routes, "/", { router: { head } });
  const adopt = await renderRoute(routes, "/", { router: { head }, hydration: "adopt" });
  const legacy = await renderRoute(routes, "/", { router: { head }, marker: "all" });
  return { legacy: legacy.html, plain: plain.html, adopt: adopt.html, state: adopt.state };
}

function runState(state: string): void {
  const body = /<script[^>]*>([\s\S]*)<\/script>/.exec(state)?.[1];
  if (body) new Function(body)();
  __resetTransfer();
}

/** One takeover of the landing page; returns milliseconds. */
export async function takeover(strategy: "replace" | "adopt", html: string, state: string): Promise<number> {
  __resetQueryCache();
  runState(state);
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  createRouter(routes, { mode: "memory", url: "/", head });
  await routerReady();
  const start = performance.now();
  if (strategy === "adopt") {
    await hydrate(() => Route(), root, { strategy: "adopt" });
  } else {
    hydrate(() => Route() as unknown as HTMLElement, root);
    // The route content renders after its microtasks; wait for the cards.
    // Polled with the same macrotask primitive adoption uses, so neither side
    // pays timer clamping the other does not.
    while (root.querySelectorAll("article.card").length < 3) await tick();
  }
  const ms = performance.now() - start;
  root.remove();
  destroyRouter();
  return ms;
}

export { renderToString };
