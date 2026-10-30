// @vitest-environment node
//
// The server-entry pre-renderer puts a rendered route into the built shell.
// Head markup and transferred JSON are inserted LITERALLY: `$&`, `$'`, `` $` ``,
// `$$`, `$1` in a title or in API data are text, never replacement patterns
// that would splice parts of the shell into the page. And a route that cannot
// render before the deadline fails the build naming the route.

// @ts-expect-error — jsdom ships no types here; this is a test-only import.
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { assertPrerendered, injectIntoShell } from "../src/build/prerenderServer";
import { div, p } from "../src/core/rendering/html";
import { query } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import type { RouteDef } from "../src/plugins/router";

const DOLLARS = "cost $& $` $' $$ $1 $2";
const BREAKOUT = "</script><script>window.pwned = 1</script>";

const SHELL = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  "    <title>Tom &amp; Jerry $&amp; Co</title>",
  "    <script>window.before = 'head script';</script>",
  '    <script type="module" crossorigin src="/assets/index-abc.js"></script>',
  "  </head>",
  "  <body>",
  '    <header id="top">header before</header>',
  '    <div id="app"></div>',
  "    <footer>footer after</footer>",
  "    <script>window.after = 'body script';</script>",
  "  </body>",
  "</html>",
].join("\n");

const routes: RouteDef[] = [
  {
    path: "/",
    component: () => {
      const q = query("/api/note", async () => ({ note: DOLLARS, html: BREAKOUT }));
      return div({ class: "page" }, [p({ class: "note" }, () => q.data()?.note ?? "")]);
    },
    head: { title: `Price ${DOLLARS}`, description: `About ${DOLLARS}` },
  },
];

describe("injectIntoShell — real head and transfer output", () => {
  it("inserts titles, descriptions and transferred data literally", async () => {
    const r = await renderRoute(routes, "/", { router: { head: { titleTemplate: "%s | Shop" } } });
    expect(r.status).toBe(200);
    const html = injectIntoShell(SHELL, { body: r.html, head: r.head, state: r.state });

    // No piece of the shell was spliced in by a replacement pattern.
    expect(html.match(/<\/head>/g)?.length).toBe(1);
    expect(html.match(/<title/g)?.length).toBe(1);
    expect(html.match(/<body>/g)?.length).toBe(1);

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const { window } = dom;
    const d = window.document;
    expect(d.title).toBe(`Price ${DOLLARS} | Shop`);
    expect(d.querySelector("title")?.getAttribute("data-sibu-base-title")).toBe("Tom & Jerry $& Co");
    expect(d.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(`About ${DOLLARS}`);
    expect(d.querySelector("#app .note")?.textContent).toBe(DOLLARS);
    expect(d.querySelector("#top")?.textContent).toBe("header before");
    expect(d.querySelector("footer")?.textContent).toBe("footer after");

    // The transferred values survive exactly, the closing-script payload included.
    const transfer = window.__SIBU_TRANSFER__ as { q: Record<string, { d: { note: string; html: string } }> };
    expect(transfer.q["/api/note"].d).toEqual({ note: DOLLARS, html: BREAKOUT });
    expect(window.pwned).toBeUndefined();

    // Scripts keep their order: the shell's own scripts as written, the
    // transfer script last, right before </body>.
    expect(window.before).toBe("head script");
    expect(window.after).toBe("body script");
    const scripts = Array.from(d.querySelectorAll("script"), (s: Element) => s.getAttribute("src") ?? s.textContent);
    expect(scripts.slice(0, 3)).toEqual([
      "window.before = 'head script';",
      "/assets/index-abc.js",
      "window.after = 'body script';",
    ]);
    expect(scripts).toHaveLength(4);
    expect(scripts[3]).toContain("window.__SIBU_TRANSFER__=");
  });

  it("keeps every replacement-sensitive sequence literal in each insertion", () => {
    for (const seq of ["$&", "$`", "$'", "$$", "$1", "$2"]) {
      const html = injectIntoShell(SHELL, {
        body: `<p>${seq}</p>`,
        head: `<title>${seq}</title>\n    <meta name="description" content="${seq}" />`,
        state: `<script>window.__S__=${JSON.stringify(seq)}</script>`,
      });
      const dom = new JSDOM(html, { runScripts: "dangerously" });
      expect(dom.window.document.title, seq).toBe(seq);
      expect(dom.window.document.querySelector('meta[name="description"]')?.getAttribute("content"), seq).toBe(seq);
      expect(dom.window.document.querySelector("#app p")?.textContent, seq).toBe(seq);
      expect(dom.window.__S__, seq).toBe(seq);
    }
  });
});

describe("assertPrerendered", () => {
  it("fails the build naming the route when it did not render before the deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stuck: RouteDef[] = [{ path: "/stuck", lazy: () => new Promise(() => {}) }];
    const r = await renderRoute(stuck, "/stuck", { timeout: 20 });
    expect(() => assertPrerendered("/stuck", r, [], 20)).toThrow(
      /^\[sibu prerender\] \/stuck: the route did not render within 20 ms \(pending: route:components/,
    );
    vi.restoreAllMocks();
  });

  it("names the unreachable API first, and passes a rendered page", async () => {
    const r = await renderRoute([{ path: "/", component: () => p("ok") }], "/");
    expect(() => assertPrerendered("/", r, [], 1000)).not.toThrow();
    expect(() => assertPrerendered("/", r, ["GET http://api/x failed (ECONNREFUSED)"], 1000)).toThrow(
      /\/: GET http:\/\/api\/x failed/,
    );
  });
});
