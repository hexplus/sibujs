import { afterEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { Landing } from "../fixtures/ssr-app/src/pages/Landing";
import { ClientOnly } from "../src/core/rendering/clientOnly";
import { div, img, p, span } from "../src/core/rendering/html";
import { beginHydration } from "../src/core/rendering/hydrationHooks";
import { onMount, onUnmount } from "../src/core/rendering/lifecycle";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { isClient, isServer, runInSSRContext } from "../src/core/ssr-context";
import { __resetQueryCache } from "../src/data/query";
import { renderToStringAsync } from "../src/platform/ssrAsync";

const PRERENDER_HOST = Symbol.for("sibujs.prerender.v1");

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[PRERENDER_HOST];
  __resetQueryCache();
});

describe("isServer() / isClient()", () => {
  it("is false in a browser, true in an SSR scope and in the pre-renderer", () => {
    expect(isServer()).toBe(false);
    expect(isClient()).toBe(true);
    runInSSRContext(() => {
      expect(isServer()).toBe(true);
      expect(isClient()).toBe(false);
    });
    (globalThis as Record<symbol, unknown>)[PRERENDER_HOST] = { route: "/", wait() {} };
    expect(isServer()).toBe(true);
  });
});

describe("ClientOnly", () => {
  it("renders the fallback on the server and the content in the browser", async () => {
    const view = () => div([ClientOnly(() => span("canvas"), { fallback: () => img({ src: "/a.png" }) })]);
    const { html } = await renderToStringAsync(view);
    expect(html).toContain('<img src="/a.png" />');
    expect(html).not.toContain("canvas");

    const client = view();
    document.body.appendChild(client);
    await Promise.resolve();
    expect(client.innerHTML).toBe("<!--when--><span>canvas</span>");
    client.remove();
  });

  it("renders nothing on the server without a fallback, and never runs the content there", async () => {
    const content = vi.fn(() => span("x"));
    const { html } = await renderToStringAsync(() => div([ClientOnly(content)]));
    expect(html).toBe('<div data-sibu-ssr="true"><!--when--></div>');
    expect(content).not.toHaveBeenCalled();
  });

  it("keeps the fallback during an adopting hydration and swaps it in one step when it ends", async () => {
    const hydration = beginHydration();
    const root = div([ClientOnly(() => span("real"), { fallback: () => span("fallback") })]);
    document.body.appendChild(root);
    await Promise.resolve();
    expect(root.textContent).toBe("fallback");
    hydration.end();
    expect(root.textContent).toBe("real");
    root.remove();
  });

  it("renders the fixture's product cards as <img> on the server", async () => {
    vi.stubGlobal("fetch", createStubFetch());
    const { html } = await renderToStringAsync(() => Landing());
    expect(html.match(/<img class="card-media" src="\/img\/[a-z]+\.png"/g)?.length).toBe(3);
    expect(html).not.toContain("<canvas");
    vi.unstubAllGlobals();
  });
});

describe("what runs on the server", () => {
  it("does not run onMount / onUnmount during SSR, even with a DOM registered", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    await renderToStringAsync(() => {
      const el = div("x");
      onMount(mounted);
      onMount(mounted, el);
      onUnmount(unmounted, el);
      return el;
    });
    expect(mounted).not.toHaveBeenCalled();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("does not run effects on the server unless they opt in with { server: true }", async () => {
    const plain = vi.fn();
    const serverSide = vi.fn();
    const { html } = await renderToStringAsync(() => {
      const [n, setN] = signal(1);
      effect(() => plain(n()));
      effect(() => serverSide(n()), { server: true });
      setN(2);
      return p(() => String(n()));
    });
    expect(plain).not.toHaveBeenCalled();
    expect(serverSide.mock.calls).toEqual([[1], [2]]);
    expect(html).toContain("2");
  });
});

describe("browser-only API reads during a server render", () => {
  it("are reported under a full DOM emulation, with the reading site", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = globalThis.localStorage;
    const { diagnostics } = await renderToStringAsync(() => {
      const theme = globalThis.localStorage?.getItem("theme") ?? "light";
      return p(theme);
    });
    expect(diagnostics.browserApis.some((s) => /^localStorage at .*ssr-client-only\.test\.ts/.test(s))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("localStorage was used during a server render"))).toBe(
      true,
    );
    // Outside a server render the same read is silent and answers as before.
    warn.mockClear();
    expect(globalThis.localStorage).toBe(storage);
    expect(warn).not.toHaveBeenCalled();
  });
});
