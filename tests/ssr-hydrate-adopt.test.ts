import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { ClientOnly } from "../src/core/rendering/clientOnly";
import { __resetIdCounter, createId } from "../src/core/rendering/createId";
import { match, when } from "../src/core/rendering/directives";
import { each } from "../src/core/rendering/each";
import { a, button, div, img, input, label, li, p, span, ul } from "../src/core/rendering/html";
import { lazy } from "../src/core/rendering/lazy";
import { signal } from "../src/core/signals/signal";
import { isServer } from "../src/core/ssr-context";
import { __resetQueryCache, query } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import { hydrate } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import { createRouter, destroyRouter, Route, routerReady } from "../src/plugins/router";
import { __resetTransfer } from "../src/utils/transfer";

const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  container.id = "app";
  document.body.appendChild(container);
  __resetIdCounter();
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetQueryCache();
  __resetTransfer();
  delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
  destroyRouter();
});

/** Run the transfer script the server emitted, as the browser would. */
function runTransferScript(state: string): void {
  const body = /<script[^>]*>([\s\S]*)<\/script>/.exec(state)?.[1];
  if (body) new Function(body)();
  __resetTransfer();
}

/** Spy on element creation and report the elements that ended up inside `container`. */
function trackCreatedElements(): () => Element[] {
  const created: Element[] = [];
  const ce = document.createElement.bind(document);
  const cens = document.createElementNS.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, o?: ElementCreationOptions) => {
    const el = ce(tag, o);
    created.push(el);
    return el;
  }) as typeof document.createElement);
  vi.spyOn(document, "createElementNS").mockImplementation(((ns: string, tag: string) => {
    const el = cens(ns, tag);
    created.push(el);
    return el;
  }) as typeof document.createElementNS);
  return () => created.filter((el) => container.contains(el));
}

async function serverRender(app: () => Node): Promise<{ html: string; state: string }> {
  const r = await renderToStringAsync(app, { hydration: "adopt" });
  return { html: r.html, state: r.state };
}

describe('hydrate(App, root, { strategy: "adopt" })', () => {
  function Card() {
    const [count, setCount] = signal(0);
    const [items] = signal(["a", "b", "c"]);
    const [open] = signal(true);
    return div({ class: "card", id: "card" }, [
      img({ src: "/hero.png", alt: "hero", width: "10" }),
      p(() => `count: ${count()}`),
      button({ on: { click: () => setCount((n) => n + 1) } }, "add"),
      when(open, () => ul([each(items, (item) => li({ "data-k": item() }, item()), { key: (x) => x })])),
      match(() => (open() ? "o" : "c"), { o: () => span("open"), c: () => span("closed") }),
    ]);
  }

  it("binds to the server nodes: no element created, no node moved, and the page stays live", async () => {
    const { html } = await serverRender(Card);
    expect(html).toContain('data-sibu-h="');
    container.innerHTML = html;
    const serverImg = container.querySelector("img");
    const serverLis = Array.from(container.querySelectorAll("li"));
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(container, { childList: true, subtree: true });

    const createdInside = trackCreatedElements();
    const result = await hydrate(Card, container, { strategy: "adopt" });
    mo.disconnect();
    records.push(...mo.takeRecords());

    expect(result.created).toBe(0);
    expect(result.mismatches).toEqual([]);
    expect(createdInside()).toEqual([]);
    expect(container.querySelector("img")).toBe(serverImg);
    expect(Array.from(container.querySelectorAll("li"))).toEqual(serverLis);
    // No element was ever added or removed — only text/comment nodes swapped for the client's own.
    for (const r of records) {
      for (const n of [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)]) expect(n.nodeType).not.toBe(1);
    }
    expect(container.querySelector("[data-sibu-h]")).toBeNull();
    expect(container.getAttribute("data-sibu-hydrated")).toBe("adopt");

    (container.querySelector("button") as HTMLButtonElement).click();
    expect(container.querySelector("p")?.textContent).toBe("count: 1");
  });

  it("ends with exactly the client's attributes: a javascript: URL injected into cached markup does not survive", async () => {
    const { html } = await serverRender(() => div([a({ href: "/ok" }, "link"), img({ src: "/a.png" })]));
    container.innerHTML = html
      .replace('href="/ok"', 'href="javascript:alert(1)" onclick="alert(2)"')
      .replace('src="/a.png"', 'src="javascript:alert(3)" data-injected="x"');
    await hydrate(() => div([a({ href: "/ok" }, "link"), img({ src: "/a.png" })]), container, { strategy: "adopt" });
    expect(container.innerHTML).not.toMatch(/javascript:|onclick|data-injected/);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/ok");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/a.png");
  });

  it("replaces only a mismatched subtree, keeps its siblings, and reports it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const App = () =>
      div({ class: "page" }, [
        p({ class: "keep" }, "stable"),
        // Deliberately non-deterministic: the server and the browser take different branches.
        div({ class: "box" }, [isServer() ? span("server only") : input({ value: "client only" })]),
        p({ class: "keep2" }, "also stable"),
      ]);
    const { html } = await serverRender(App);
    container.innerHTML = html;
    const keep = container.querySelector(".keep");
    const keep2 = container.querySelector(".keep2");
    const box = container.querySelector(".box");

    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector(".keep")).toBe(keep);
    expect(container.querySelector(".keep2")).toBe(keep2);
    expect(container.querySelector(".box")).toBe(box);
    expect(container.querySelector("span")).toBeNull();
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("client only");
    expect(result.mismatches.map((m) => m.kind)).toEqual(["tag", "extra"]);
    expect(result.mismatches[0]).toMatchObject({ serverValue: "span", clientValue: "input" });
    expect(result.mismatches[0].path).toContain("div.page > div.box > span");
    expect(result.mismatches[0].cause).toMatch(/browser-only read|non-deterministic/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("adopt mismatch at"))).toBe(true);
  });

  it("warns when the root itself does not match, instead of replacing silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    container.innerHTML = '<section data-sibu-h="0">server</section>';
    const result = await hydrate(() => div("client"), container, { strategy: "adopt" });
    expect(result.replacedRoot).toBe(true);
    expect(container.textContent).toBe("client");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("whole tree is replaced"))).toBe(true);
  });

  it("keeps what the user typed before takeover, and tells the app's handlers", async () => {
    const [name, setName] = signal("");
    const Form = () =>
      div([
        label({ for: "n" }, "Name"),
        input({
          id: "n",
          value: () => name(),
          on: { input: (e: Event) => setName((e.target as HTMLInputElement).value) },
        }),
        input({ id: "c", type: "checkbox" }),
      ]);
    const { html } = await serverRender(Form);
    container.innerHTML = html;
    const field = container.querySelector("#n") as HTMLInputElement;
    const box = container.querySelector("#c") as HTMLInputElement;
    field.focus();
    field.value = "Ada";
    box.checked = true;

    await hydrate(Form, container, { strategy: "adopt" });
    expect(container.querySelector("#n")).toBe(field);
    expect(field.value).toBe("Ada");
    expect(box.checked).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(name()).toBe("Ada");
  });

  it("swaps a ClientOnly fallback for its content once adoption ends", async () => {
    const App = () =>
      div([ClientOnly(() => span({ class: "canvas" }, "canvas"), { fallback: () => img({ src: "/p.png" }) })]);
    const { html } = await serverRender(App);
    container.innerHTML = html;
    const fallback = container.querySelector("img");
    const result = await hydrate(App, container, { strategy: "adopt" });
    // The fallback was adopted; the content is built once adoption is over.
    expect(result.created).toBe(0);
    expect(result.mismatches).toEqual([]);
    expect(fallback?.isConnected).toBe(false);
    expect(container.querySelector(".canvas")?.textContent).toBe("canvas");
  });

  it("lines createId() up between server and browser", async () => {
    const App = () => {
      const id = createId("f");
      return div([label({ for: id }, "x"), input({ id })]);
    };
    const { html } = await serverRender(App);
    container.innerHTML = html;
    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(result.mismatches).toEqual([]);
    expect(container.querySelector("label")?.getAttribute("for")).toBe(container.querySelector("input")?.id);
  });

  it("adopts a lazy component's server content when its chunk loads", async () => {
    const Lazy = lazy(() => delay(5, { default: () => p({ class: "lazy" }, "loaded") }));
    const App = () => div([Lazy()]);
    const { html } = await serverRender(App);
    container.innerHTML = html;
    const serverP = container.querySelector(".lazy");
    expect(serverP).not.toBeNull();
    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(result.mismatches).toEqual([]);
    expect(container.querySelector(".lazy")).toBe(serverP);
    expect(container.textContent).not.toContain("Loading");
  });

  it("restores transferred query data so a data-driven tree adopts without fetching", async () => {
    const fetcher = vi.fn(() => delay(2, ["x", "y"]));
    const App = () => {
      const q = query("/api/list", fetcher, { staleTime: 60_000 });
      return ul([
        each(
          () => q.data() ?? [],
          (v) => li(v()),
          { key: (v) => v },
        ),
      ]);
    };
    const r = await renderToStringAsync(App, { hydration: "adopt" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    runTransferScript(r.state);
    container.innerHTML = r.html;
    const lis = Array.from(container.querySelectorAll("li"));
    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(0);
    expect(Array.from(container.querySelectorAll("li"))).toEqual(lis);
  });
});

describe("adopting the fixture landing page through the router", () => {
  it("creates zero element nodes and keeps the exact <img> nodes", async () => {
    vi.stubGlobal("fetch", createStubFetch());
    const server = await renderRoute(routes, "/", { router: { head }, hydration: "adopt" });
    expect(server.status).toBe(200);
    runTransferScript(server.state);
    container.innerHTML = server.html;
    const hero = container.querySelector("img.hero-img");
    const cardImages = Array.from(container.querySelectorAll("img.card-media"));
    expect(hero).not.toBeNull();
    expect(cardImages.length).toBe(3);

    const clientFetch = createStubFetch();
    vi.stubGlobal("fetch", clientFetch);
    createRouter(routes, { mode: "memory", url: "/", head });
    await routerReady();
    const createdInside = trackCreatedElements();
    const result = await hydrate(() => Route(), container, { strategy: "adopt" });

    expect(result.mismatches).toEqual([]);
    expect(clientFetch.calls).toEqual([]);
    // The product cards swap their <img> for a <canvas> (ClientOnly) once
    // adoption ends; everything the server rendered was adopted, nothing else built.
    const createdNotCanvas = createdInside().filter((el) => el.localName !== "canvas");
    expect(createdNotCanvas).toEqual([]);
    expect(result.adopted).toBeGreaterThan(20);
    // The hero <img> is the server's node: never re-created, so never reloaded.
    expect(container.querySelector("img.hero-img")).toBe(hero);
    expect(hero?.getAttribute("src")).toBe("/img/hero.jpg");
    for (const imgEl of cardImages) expect(imgEl.isConnected).toBe(false);
    expect(container.querySelectorAll("canvas").length).toBe(3);
  });
});
