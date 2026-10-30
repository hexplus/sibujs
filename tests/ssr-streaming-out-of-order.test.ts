// @ts-expect-error — jsdom ships no types here; this is a test-only import.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { div, h1, p, section, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { query } from "../src/data/query";
import { Head } from "../src/platform/head";
import { renderToReadableStream } from "../src/platform/ssr";

const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

afterEach(() => {
  vi.restoreAllMocks();
});

async function readAll(stream: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

/** A boundary whose content waits `ms` for its data. */
function Slow(label: string, ms: number) {
  return Suspense({
    nodes: () => {
      const q = query(`/api/${label}`, () => delay(ms, `${label} data`));
      return div({ class: label }, [span(() => q.data() ?? "")]);
    },
    fallback: () => p({ class: "skeleton" }, `loading ${label}`),
  });
}

function Page() {
  return section([
    Head({ title: "Streamed page", meta: [{ name: "description", content: "stream" }] }),
    h1(() => {
      const q = query("/api/title", () => delay(1, "Shop"));
      return q.data() ?? "";
    }),
    Slow("slow", 600),
    Slow("fast", 250),
  ]);
}

describe("renderToReadableStream(() => App()) — out-of-order Suspense", () => {
  it("flushes the head and the shell first, then each boundary as soon as IT is ready", async () => {
    const chunks = await readAll(renderToReadableStream(Page, { nonce: "abc", document: { scripts: ["/main.js"] } }));
    const [shell] = chunks;
    // Head before the body, in the first chunk.
    expect(shell.indexOf("<title>Streamed page</title>")).toBeLessThan(shell.indexOf("<body"));
    // Data outside the boundaries was awaited for the shell.
    expect(shell).toContain("<h1><!---->Shop</h1>");
    // Both boundaries are still on their fallback in the shell.
    expect(shell).toContain("loading slow");
    expect(shell).toContain("loading fast");
    const fastAt = chunks.findIndex((c) => c.includes("fast data"));
    const slowAt = chunks.findIndex((c) => c.includes("slow data"));
    // `fast` comes after `slow` in the page but streams first.
    expect(fastAt).toBeGreaterThan(0);
    expect(slowAt).toBeGreaterThan(fastAt);
    for (const c of [chunks[fastAt], chunks[slowAt]]) expect(c).toContain('<script nonce="abc">');
    const last = chunks[chunks.length - 1];
    expect(last).toContain("window.__SIBU_TRANSFER__=");
    expect(last.indexOf("__SIBU_TRANSFER__")).toBeLessThan(last.indexOf('<script src="/main.js">'));
    expect(last.trim().endsWith("</html>")).toBe(true);
  });

  it("produces a document whose swap scripts put every boundary's content in place", async () => {
    const html = (await readAll(renderToReadableStream(Page))).join("");
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const d = dom.window.document;
    expect(d.querySelector(".slow")?.textContent).toBe("slow data");
    expect(d.querySelector(".fast")?.textContent).toBe("fast data");
    expect(d.querySelector(".skeleton")).toBeNull();
    expect(d.querySelector("[id^=sibu-resolved-]")).toBeNull();
    expect(d.title).toBe("Streamed page");
  });

  it("keeps the fallback of a boundary that misses the timeout and still ends the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunks = await readAll(
      renderToReadableStream(() => section([Slow("never", 5000), Slow("quick", 5)]), { timeout: 60, document: false }),
    );
    const html = chunks.join("");
    expect(html).toContain("loading never");
    expect(html).toContain("quick data");
    expect(html).not.toContain("never data");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("kept the fallback"))).toBe(true);
  });

  it("streams a lazy() component inside a boundary when its chunk arrives", async () => {
    // Long enough that a loaded machine still flushes the shell first.
    const Chart = lazy(() => delay(250, { default: () => div({ class: "chart" }, "chart drawn") }));
    const chunks = await readAll(
      renderToReadableStream(
        () => section([p("intro"), Suspense({ nodes: () => Chart(), fallback: () => p("loading chart") })]),
        { document: false },
      ),
    );
    expect(chunks[0]).toContain("loading chart");
    expect(chunks[0]).not.toContain("chart drawn");
    expect(chunks.join("")).toContain("chart drawn");
  });

  it("produces the next chunk only when the previous one has been read, and stops on cancel", async () => {
    const stream = renderToReadableStream(() => section([Slow("a", 5), Slow("b", 10)]), { document: false });
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value).toContain("loading a");
    await reader.cancel();
    const after = await reader.read().catch(() => ({ done: true }));
    expect(after.done).toBe(true);
  });

  it("rejects the stream when the shell throws, naming where", async () => {
    const stream = renderToReadableStream(() =>
      section({ class: "boom" }, [
        p(() => {
          throw new Error("shell broke");
        }),
      ]),
    );
    await expect(readAll(stream)).rejects.toThrow(/section\.boom > p: shell broke/);
  });

  it("leaves the node-based renderToReadableStream unchanged", async () => {
    const chunks = await readAll(renderToReadableStream(div([p("a")])));
    expect(chunks.join("")).toBe('<div data-sibu-ssr="true"><p data-sibu-ssr="true">a</p></div>');
  });
});
