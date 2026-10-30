import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { match, when } from "../src/core/rendering/directives";
import { each } from "../src/core/rendering/each";
import { div, li, p, section, span, ul } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { signal } from "../src/core/signals/signal";
import { runInSSRContext } from "../src/core/ssr-context";
import { query } from "../src/data/query";
import { resource } from "../src/data/resource";
import { renderToDocumentAsync, renderToStringAsync, settled } from "../src/platform/ssrAsync";
import { prerenderWait } from "../src/utils/prerenderHook";

const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderToStringAsync — waits for the tree to settle", () => {
  it("serializes nested when > each > lazy > query with a single await", async () => {
    const Card = lazy(async () => {
      await delay(5, null);
      return {
        default: () => {
          const q = query("product:1", () => delay(10, { name: "Mug" }));
          return div({ class: "card" }, [span(() => q.data()?.name ?? "…")]);
        },
      };
    });
    const [items] = signal(["a", "b"]);
    const { html, status } = await renderToStringAsync(() =>
      section([
        when(
          () => true,
          () => ul([each(items, (item) => li([item(), Card()]), { key: (x) => x })]),
        ),
      ]),
    );
    expect(status).toBe(200);
    expect(html).toContain("<li>a");
    expect(html).toContain("<li>b");
    expect(html.match(/<span><!---->Mug<\/span>/g)?.length).toBe(2);
    expect(html).not.toContain("Loading...");
  });

  it("waits for match() branches and resource() values", async () => {
    const [mode] = signal<"a" | "b">("b");
    const { html } = await renderToStringAsync(() => {
      const r = resource(() => delay(5, "loaded"));
      return div([match(() => mode(), { a: () => p("A"), b: () => p(() => r.data() ?? "pending") })]);
    });
    expect(html).toBe('<div data-sibu-ssr="true"><!--match--><p><!---->loaded</p></div>');
  });

  it("waits for a resource() with a source, which used to never fetch on the server", async () => {
    const [id] = signal(7);
    const { html } = await renderToStringAsync(() => {
      const r = resource(id, (n) => delay(3, `item ${n}`));
      return p(() => r.data() ?? "none");
    });
    expect(html).toContain("item 7");
  });

  it("waits for prerenderWait() promises", async () => {
    const { html } = await renderToStringAsync(() => {
      const [text, setText] = signal("before");
      prerenderWait(delay(5, null).then(() => setText("after")));
      return p(() => text());
    });
    expect(html).toContain("after");
  });

  it("does not wait for a query that is disabled, or opted out with ssr: false", async () => {
    const fetcher = vi.fn(() => delay(5, 1));
    const { html, diagnostics } = await renderToStringAsync(() => {
      const off = query("off", fetcher, { enabled: false });
      const skipped = query("skipped", fetcher, { ssr: false });
      return p(() => `${off.data() ?? "idle"} ${skipped.loading() ? "loading" : (skipped.data() ?? "idle")}`);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain("idle idle");
    expect(diagnostics.timedOut).toBe(false);
  });

  it("does not hang on refetchInterval: intervals are off during SSR", async () => {
    const fetcher = vi.fn(() => Promise.resolve("v"));
    const started = Date.now();
    const { html } = await renderToStringAsync(() => {
      const q = query("interval", fetcher, { refetchInterval: 1, refetchOnWindowFocus: true });
      return p(() => q.data() ?? "");
    });
    expect(html).toBe('<p data-sibu-ssr="true"><!---->v</p>');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("renderToStringAsync — timeout", () => {
  it("serializes what is ready, keeps Suspense fallbacks, and reports what was pending", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Slow = lazy(() => delay(400, { default: () => div("slow content") }));
    const { html, diagnostics } = await renderToStringAsync(
      () =>
        div([
          p("ready"),
          Suspense({ nodes: () => Slow(), fallback: () => span({ class: "skeleton" }, "loading card") }),
        ]),
      { timeout: 30 },
    );
    expect(html).toContain("<p>ready</p>");
    expect(html).toContain('<span class="skeleton">loading card</span>');
    expect(html).not.toContain("slow content");
    expect(diagnostics.timedOut).toBe(true);
    expect(diagnostics.pending.some((label) => label.startsWith("lazy"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("did not settle"))).toBe(true);
  });

  it("names a pending query by its key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { diagnostics } = await renderToStringAsync(
      () => {
        const q = query("/api/slow", () => delay(400, 1));
        return p(() => String(q.data() ?? "…"));
      },
      { timeout: 20 },
    );
    expect(diagnostics.pending[0]).toMatch(/^query:\/api\/slow \(\d+ ms\)$/);
  });
});

describe("renderToStringAsync — errors", () => {
  it("renders an ErrorBoundary fallback for an error inside it", async () => {
    const { html } = await renderToStringAsync(() =>
      div([
        ErrorBoundary({ fallback: (err: Error) => p(`failed: ${err.message}`) }, () => {
          throw new Error("boom");
        }),
      ]),
    );
    expect(html).toContain("failed: boom");
  });

  it("rejects an uncaught error with the failing node's path in the message", async () => {
    const [n, setN] = signal(0);
    const failing = renderToStringAsync(() => {
      prerenderWait(delay(2, null).then(() => setN(1)));
      return section({ class: "grid" }, [
        div({ id: "card" }, [
          span(() => {
            if (n() === 1) throw new Error("price missing");
            return "ok";
          }),
        ]),
      ]);
    });
    await expect(failing).rejects.toThrow(/render failed.*section\.grid > div#card > span: price missing/);
  });

  it("rejects a synchronous throw of the root builder", async () => {
    await expect(
      renderToStringAsync(() => {
        throw new Error("bad root");
      }),
    ).rejects.toThrow("bad root");
  });
});

describe("renderToDocumentAsync", () => {
  it("wraps the settled body and the transfer script in the renderToDocument shell", async () => {
    const { html, state } = await renderToDocumentAsync(
      () => {
        const q = query("/api/catalog", () => delay(2, [{ id: 1, name: "Mug </script>" }]));
        return div(() => q.data()?.[0].name ?? "");
      },
      { title: "Shop", nonce: "abc" },
    );
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Shop</title>");
    expect(html).toContain("Mug &lt;/script&gt;");
    expect(state).toContain('<script nonce="abc">window.__SIBU_TRANSFER__=');
    expect(state).not.toContain("</script><");
    expect(state).toContain("\\u003c/script\\u003e");
    expect(html).toContain(state);
  });
});

describe("settled()", () => {
  it("is usable directly in a custom pipeline", async () => {
    await runInSSRContext(async () => {
      const [v, setV] = signal("a");
      const root = div(() => v());
      prerenderWait(delay(5, null).then(() => setV("b")));
      const result = await settled(root);
      expect(result).toEqual({ timedOut: false, pending: [] });
      expect(root.textContent).toBe("b");
    });
  });

  it("isolates concurrent requests: each waits only for its own work", async () => {
    const render = (ms: number, label: string) =>
      renderToStringAsync(() => {
        const q = query("shared-key", () => delay(ms, label));
        return p(() => q.data() ?? "");
      });
    const [slow, fast] = await Promise.all([render(40, "slow"), render(5, "fast")]);
    expect(slow.html).toContain("slow");
    expect(fast.html).toContain("fast");
    expect(slow.stateData).toMatchObject({ q: { "shared-key": { d: "slow" } } });
    expect(fast.stateData).toMatchObject({ q: { "shared-key": { d: "fast" } } });
  });
});

describe("render diagnostics summary", () => {
  it("formats pending work, browser-API reads and the state, and logs it on request", async () => {
    const { formatRenderDiagnostics } = await import("../src/platform/ssrAsync");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await renderToStringAsync(
      () => {
        query("/api/big", () => delay(1, "x".repeat(50)));
        query("/api/never", () => delay(500, 1));
        globalThis.localStorage?.getItem("k");
        return p("x");
      },
      { timeout: 30, log: "/landing" },
    );
    const text = formatRenderDiagnostics(r.diagnostics, "/landing");
    expect(text).toMatch(/^\[SibuJS SSR\] \/landing: \d+ ms, TIMED OUT/);
    expect(text).toContain("pending at the timeout: query:/api/never");
    expect(text).toContain("browser-only APIs read: localStorage at");
    expect(text).toMatch(/transferred state: \d+ B; largest: q:\/api\/big \(\d+ B\)/);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[SibuJS SSR] /landing:"));
  });
});
