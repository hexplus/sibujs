// @vitest-environment node
/**
 * The server DOM setup AGENTS.md §10 documents for `renderToString` in plain
 * Node: register a jsdom window's globals, then build and serialize the tree.
 * If this recipe stops being enough, the docs are wrong.
 */
// @ts-expect-error — jsdom ships no types here; this is a test-only import.
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GLOBALS = ["window", "document", "Node", "Element", "HTMLElement", "DocumentFragment"] as const;
const saved = new Map<string, unknown>();

beforeAll(() => {
  const { window } = new JSDOM("");
  for (const key of GLOBALS) {
    saved.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = key === "window" ? window : window[key];
  }
});

afterAll(() => {
  for (const key of GLOBALS) (globalThis as Record<string, unknown>)[key] = saved.get(key);
});

describe("renderToString in plain Node with jsdom globals", () => {
  it("renders the documented repro", async () => {
    const { div } = await import("../src/core/rendering/html");
    const { renderToString } = await import("../src/platform/ssr");
    expect(renderToString(div("x"))).toBe('<div data-sibu-ssr="true">x</div>');
  });

  it("renders SVG, reactive text, when and each inside runInSSRContext after a microtask", async () => {
    const { div, li, path, svg, ul } = await import("../src/core/rendering/html");
    const { when } = await import("../src/core/rendering/directives");
    const { each } = await import("../src/core/rendering/each");
    const { signal } = await import("../src/core/signals/signal");
    const { runInSSRContext } = await import("../src/core/ssr-context");
    const { renderToString } = await import("../src/platform/ssr");

    const out = await runInSSRContext(async () => {
      const [items] = signal(["a", "b"]);
      const [name] = signal("Ada");
      const tree = div([
        svg({ viewBox: "0 0 24 24" }, [path({ d: "M4 12h16" })]),
        div(() => `Hi ${name()}`),
        when(
          () => true,
          () => div("shown"),
        ),
        ul([each(items, (item) => li(() => item()), { key: (s) => s })]),
      ]);
      // `when` / `match` / `each` render their first branch in a microtask,
      // once their anchor is attached: let it run before serializing.
      await Promise.resolve();
      return renderToString(tree);
    });
    expect(out).toContain('<svg viewBox="0 0 24 24" data-sibu-ssr="true"><path d="M4 12h16" data-sibu-ssr="true" />');
    expect(out).toContain("Hi Ada");
    expect(out).toContain("shown");
    expect(out).toContain('<li data-sibu-ssr="true"><!---->a</li><li data-sibu-ssr="true"><!---->b</li>');
  });
});
