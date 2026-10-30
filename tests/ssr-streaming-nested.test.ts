// @ts-expect-error — jsdom ships no types here; this is a test-only import.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import { button, div, p, section, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { query } from "../src/data/query";
import { renderToReadableStream } from "../src/platform/ssr";

// Nested Suspense boundaries in an out-of-order stream. A boundary may stream
// on its own only once its target is in the delivered document — when every
// enclosing boundary has been published. One that is ready earlier travels
// with its ancestor's chunk, exactly once. Each test runs the streamed
// document's swap scripts in a DOM and inspects the final page.

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A boundary whose content waits for `data`, with `children` inside it. */
function Boundary(name: string, data: Promise<string>, children: Node[] = []) {
  return Suspense({
    nodes: () => {
      const q = query(`/api/${name}`, () => data);
      return div({ class: `content-${name}` }, [
        span({ class: `text-${name}` }, () => q.data() ?? ""),
        button({ id: `btn-${name}` }, name),
        ...children,
      ]);
    },
    fallback: () => p({ class: `fallback-${name}` }, `loading ${name}`),
  });
}

/** A streamed page read chunk by chunk, so the test decides when data arrives. */
function open(app: () => Node, options: Parameters<typeof renderToReadableStream>[1] = {}) {
  // Body markup only: each read is the shell, then one boundary.
  const reader = (renderToReadableStream(app, { document: false, ...options }) as ReadableStream<string>).getReader();
  const chunks: string[] = [];
  return {
    chunks,
    async next(): Promise<string | null> {
      const { value, done } = await reader.read();
      if (done) return null;
      chunks.push(value);
      return value;
    },
    async rest(): Promise<void> {
      while ((await this.next()) !== null) {}
    },
    cancel: () => reader.cancel(),
  };
}

/** The final page after the browser ran every swap script. */
function finalDocument(chunks: string[]): Document {
  return new JSDOM(chunks.join(""), { runScripts: "dangerously" }).window.document;
}

function expectClean(d: Document, names: string[]): void {
  expect(d.querySelectorAll("[id^=sibu-resolved-]")).toHaveLength(0);
  for (const name of names) {
    expect(d.querySelectorAll(`#btn-${name}`), name).toHaveLength(1);
    expect(d.querySelector(`.text-${name}`)?.textContent, name).toBe(`${name} data`);
    expect(d.querySelector(`.fallback-${name}`), name).toBeNull();
  }
}

describe("streaming nested Suspense boundaries", () => {
  it("carries an inner boundary that resolved first with its outer one, once", async () => {
    const outer = deferred<string>();
    const inner = deferred<string>();
    const s = open(() => section([Boundary("outer", outer.promise, [Boundary("inner", inner.promise)])]));
    const shell = (await s.next()) ?? "";
    expect(shell).toContain("loading outer");
    inner.resolve("inner data");
    await delay(30);
    outer.resolve("outer data");
    await s.rest();

    const d = finalDocument(s.chunks);
    expectClean(d, ["outer", "inner"]);
    expect(d.querySelector(".content-outer .content-inner")).not.toBeNull();
    // One payload, the outer one, carried the inner content.
    expect(s.chunks.join("").match(/id="sibu-resolved-/g)).toHaveLength(1);
  });

  it("streams an inner boundary on its own once its outer one is published", async () => {
    const outer = deferred<string>();
    const inner = deferred<string>();
    const s = open(() => section([Boundary("outer", outer.promise, [Boundary("inner", inner.promise)])]));
    await s.next();
    outer.resolve("outer data");
    const outerChunk = (await s.next()) ?? "";
    expect(outerChunk).toContain("outer data");
    expect(outerChunk).toContain("loading inner");
    expect(outerChunk).not.toContain("inner data");
    inner.resolve("inner data");
    await s.rest();

    const d = finalDocument(s.chunks);
    expectClean(d, ["outer", "inner"]);
    expect(s.chunks.join("").match(/id="sibu-resolved-/g)).toHaveLength(2);
  });

  it("handles three levels resolving in any order", async () => {
    const orders = [
      ["c", "b", "a"],
      ["b", "c", "a"],
      ["a", "c", "b"],
      ["c", "a", "b"],
    ];
    for (const order of orders) {
      const data = { a: deferred<string>(), b: deferred<string>(), c: deferred<string>() };
      const s = open(() =>
        section([Boundary("a", data.a.promise, [Boundary("b", data.b.promise, [Boundary("c", data.c.promise)])])]),
      );
      await s.next();
      for (const name of order) {
        data[name as "a" | "b" | "c"].resolve(`${name} data`);
        await delay(20);
      }
      await s.rest();
      const d = finalDocument(s.chunks);
      expect(d.querySelectorAll("[id^=sibu-resolved-]"), order.join()).toHaveLength(0);
      for (const name of ["a", "b", "c"]) {
        expect(d.querySelectorAll(`#btn-${name}`), `${order.join()} ${name}`).toHaveLength(1);
        expect(d.querySelector(`.text-${name}`)?.textContent, `${order.join()} ${name}`).toBe(`${name} data`);
      }
    }
  });

  it("keeps independent siblings out of order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const s = open(() => section([Boundary("first", first.promise), Boundary("second", second.promise)]));
    await s.next();
    second.resolve("second data");
    const next = (await s.next()) ?? "";
    expect(next).toContain("second data");
    expect(next).not.toContain("first data");
    first.resolve("first data");
    await s.rest();
    expectClean(finalDocument(s.chunks), ["first", "second"]);
  });

  it("leaves a completed child inside a parent that timed out on the parent's fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outer = deferred<string>();
    const inner = deferred<string>();
    const s = open(() => section([Boundary("outer", outer.promise, [Boundary("inner", inner.promise)])]), {
      timeout: 150,
    });
    await s.next();
    inner.resolve("inner data");
    await s.rest();
    const d = finalDocument(s.chunks);
    expect(d.querySelector(".fallback-outer")).not.toBeNull();
    expect(d.querySelectorAll("#btn-inner")).toHaveLength(0);
    expect(d.querySelectorAll("[id^=sibu-resolved-]")).toHaveLength(0);
    outer.resolve("late");
  });

  it("fails the stream when a nested lazy child rejects before its parent is published", async () => {
    const outer = deferred<string>();
    const chunk = deferred<{ default: () => Element }>();
    const Lazy = lazy(() => chunk.promise);
    const App = () =>
      section([
        Boundary("outer", outer.promise, [
          Suspense({ nodes: () => div([Lazy()]), fallback: () => p("loading lazy") }) as unknown as Node,
        ]),
      ]);
    const s = open(App);
    await s.next();
    chunk.reject(new Error("nested chunk 404"));
    const error = await s.rest().then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toContain("nested chunk 404");
    outer.resolve("late");
  });

  it("stops at once when the reader cancels with nested boundaries pending", async () => {
    const released = vi.fn();
    const outer = deferred<string>();
    const inner = deferred<string>();
    const s = open(
      () => {
        const root = section([Boundary("outer", outer.promise, [Boundary("inner", inner.promise)])]);
        registerDisposer(root, released);
        return root;
      },
      { timeout: 60_000 },
    );
    await s.next();
    inner.resolve("inner data");
    await s.cancel();
    for (let i = 0; i < 100 && released.mock.calls.length === 0; i++) await delay(10);
    expect(released).toHaveBeenCalledTimes(1);
    outer.resolve("late");
  });
});
