import { afterEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, p } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { runInSSRContext, trackPending } from "../src/core/ssr-context";
import { Head } from "../src/platform/head";
import { renderRoute } from "../src/platform/renderRoute";
import { collectServerHead, recordServerHead } from "../src/platform/serverHead";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import { destroyRouter, navigate, type RouteDef } from "../src/plugins/router";
import { delay, later, renderQueryBackedHead, renderTemporaryBranch } from "./ssr-head-lifecycle.cases";

afterEach(() => {
  vi.restoreAllMocks();
  destroyRouter();
});

describe("a server Head() layer belongs to its component", () => {
  it("is withdrawn with a when() branch removed before serialization — title and noindex included", async () => {
    const r = await renderTemporaryBranch();
    expect(r.html).toContain("final body");
    expect(r.html).not.toContain("temporary body");
    expect(r.head).toContain("<title>Page</title>");
    expect(r.head).not.toContain("Temporary");
    expect(r.head).not.toContain("noindex");
    // The removed inner description reveals the outer one.
    expect(r.head).toContain('content="Outer description"');
    expect(r.head).not.toContain("Inner description");
    expect(r.noindex).toBe(false);
  });

  it("takes the metadata of the branch that replaced it", async () => {
    const r = await renderToStringAsync(() => {
      const [view, setView] = signal<"a" | "b">("a");
      later(5, setView, "b");
      return div([
        Head({ title: "Shell" }),
        match(() => view(), {
          a: () => div([Head({ title: "A", meta: [{ name: "description", content: "about A" }] }), p("A")]),
          b: () => div([Head({ title: "B", meta: [{ property: "og:title", content: "B for previews" }] }), p("B")]),
        }),
      ]);
    });
    expect(r.html).toContain("<p>B</p>");
    expect(r.head).toContain("<title>B</title>");
    expect(r.head).toContain('content="B for previews"');
    expect(r.head).not.toContain("about A");
  });

  it("is withdrawn once: a repeated withdraw or dispose removes nothing else", async () => {
    await runInSSRContext(async () => {
      const outer = recordServerHead({ title: "Outer", tags: [] });
      const inner = recordServerHead({ title: "Inner", tags: [] });
      expect(collectServerHead()).toBe("<title>Inner</title>");
      inner?.();
      inner?.();
      expect(collectServerHead()).toBe("<title>Outer</title>");
      outer?.();
      expect(collectServerHead()).toBe("");

      const first = Head({ title: "First" });
      Head({ title: "Second" });
      Head({ title: "Third" });
      const holder = div([first]);
      expect(collectServerHead()).toBe("<title>Third</title>");
      dispose(holder);
      dispose(holder);
      dispose(first);
      expect(collectServerHead()).toBe("<title>Third</title>");
    });
  });

  it("keeps concurrent requests' head layers apart", async () => {
    const page = (title: string, ms: number) => () => {
      const [show, setShow] = signal(true);
      later(ms, setShow, false);
      return div([
        Head({ title }),
        when(
          () => show(),
          () => div([Head({ title: `${title} (temporary)`, meta: [{ name: "robots", content: "noindex" }] })]),
        ),
      ]);
    };
    const [a, b] = await Promise.all([renderToStringAsync(page("Alpha", 15)), renderToStringAsync(page("Beta", 5))]);
    expect(a.head).toBe("<title>Alpha</title>");
    expect(b.head).toBe("<title>Beta</title>");
  });

  it("replaces the route head when the request navigates again", async () => {
    const routes: RouteDef[] = [
      {
        path: "/",
        component: () => {
          trackPending(
            delay(1).then(() => navigate("/final")),
            "test:navigate",
          );
          return p("start");
        },
        head: { title: "Start", robots: "noindex" },
      },
      { path: "/final", component: () => p("final"), head: { title: "Final", description: "The final page" } },
    ];
    const r = await renderRoute(routes, "/");
    expect(r.html).toContain("final");
    expect(r.head).toContain("<title>Final</title>");
    expect(r.head).toContain("The final page");
    expect(r.head).not.toContain("Start");
    expect(r.head).not.toContain("noindex");
  });
});

describe("server Head() getters are resolved against the settled render", () => {
  it("renders a query-backed title, description and og:title with the loaded data", async () => {
    const r = await renderQueryBackedHead();
    expect(r.html).toContain("Loaded title");
    expect(r.head).toContain("<title>Loaded title</title>");
    expect(r.head).toContain('<meta name="description" content="About Loaded title" />');
    expect(r.head).toContain('<meta property="og:title" content="Loaded title" />');
    expect(r.head).not.toContain("Loading");
  });

  it("sees a value set by another unit of async work", async () => {
    const r = await renderToStringAsync(() => {
      const [name, setName] = signal("draft");
      later(10, setName, "published");
      return div([Head({ title: () => `Post: ${name()}` })]);
    });
    expect(r.head).toBe("<title>Post: published</title>");
  });

  it("never runs the getters of a withdrawn layer", async () => {
    const getter = vi.fn(() => "Temporary");
    const r = await renderToStringAsync(() => {
      const [show, setShow] = signal(true);
      later(5, setShow, false);
      return div([
        Head({ title: "Kept" }),
        when(
          () => show(),
          () => div([Head({ title: getter })]),
        ),
      ]);
    });
    expect(r.head).toBe("<title>Kept</title>");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects the render when a getter throws, and still releases the tree", async () => {
    const released = vi.fn();
    const render = renderToStringAsync(() => {
      const root = div([
        Head({
          title: () => {
            throw new Error("title lookup failed");
          },
        }),
      ]);
      registerDisposer(root, released);
      return root;
    });
    await expect(render).rejects.toThrow(/a head value threw .*title lookup failed/);
    await render.catch((err: Error) => expect((err.cause as Error).message).toBe("title lookup failed"));
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("escapes and filters the FINAL values through the shared head policy", async () => {
    const r = await renderToStringAsync(() => {
      const [v, setV] = signal("safe");
      later(5, setV, "late");
      return div([
        Head({
          title: () => (v() === "late" ? "</title><script>alert(1)</script>" : "ok"),
          meta: [
            { name: "description", content: () => (v() === "late" ? '"><script>alert(1)</script>' : "ok") },
            // A reactive entry never publishes a refresh, as in the browser.
            { "http-equiv": () => (v() === "late" ? "refresh" : "x-ua"), content: "5;url=https://x.test/" },
          ],
        }),
      ]);
    });
    expect(r.head).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(r.head).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(r.head).not.toContain("<script");
    expect(r.head).not.toContain("refresh");
  });

  it("resolves route head getters against the settled render, and still rejects unsafe URLs", async () => {
    const [title, setTitle] = signal("Loading");
    const routes: RouteDef[] = [
      {
        path: "/",
        component: () => {
          later(5, setTitle, "Loaded route");
          return p(() => title());
        },
        head: {
          title: () => title(),
          canonical: () => (title() === "Loaded route" ? "javascript:alert(1)" : "https://x.test/"),
        },
      },
    ];
    const r = await renderRoute(routes, "/");
    expect(r.html).toContain("Loaded route");
    expect(r.head).toContain("<title>Loaded route</title>");
    expect(r.head).not.toContain("javascript:");
    expect(r.head).not.toContain('rel="canonical"');
  });
});
