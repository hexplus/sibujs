// Bundled by bench/ssr-dom.mjs: the fixture landing page, rendered on whatever
// DOM the benchmark registered.
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { Landing } from "../fixtures/ssr-app/src/pages/Landing";
import { renderToStringAsync } from "../src/platform/ssrAsync";

export { installServerDom } from "../src/platform/serverDom";

globalThis.fetch = createStubFetch();

export async function renderLanding(): Promise<string> {
  const { html, state } = await renderToStringAsync(() => Landing());
  return html + state;
}
