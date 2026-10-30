import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { registerDisposer } from "../src/core/rendering/dispose";
import { div, p, section, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { query } from "../src/data/query";
import { renderToReadableStream } from "../src/platform/ssr";

// An error no `ErrorBoundary` claims fails the stream wherever it occurs — the
// shell has been sent, so the stream errors (it cannot change the status) —
// and an `ErrorBoundary` that claims it keeps the stream healthy.

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

/** Read every chunk; the error the stream failed with, if any. */
function readAll(stream: ReadableStream<string>): Promise<{ chunks: string[]; error: Error | null }> {
  return drain(stream.getReader());
}

/** Read every remaining chunk of `reader`; the error the stream failed with, if any. */
async function drain(reader: ReadableStreamDefaultReader<string>): Promise<{ chunks: string[]; error: Error | null }> {
  const chunks: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { chunks, error: null };
      chunks.push(value);
    }
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

/** A boundary around a lazy component whose import is `chunk`. */
function LazyBoundary(chunk: Promise<{ default: () => Element }>) {
  const Lazy = lazy(() => chunk);
  return Suspense({ nodes: () => div({ class: "lazy-content" }, [Lazy()]), fallback: () => p("loading part") });
}

describe("streaming: unclaimed errors after the shell", () => {
  it("errors the stream when a boundary's lazy import rejects after the shell was sent", async () => {
    const chunk = deferred<{ default: () => Element }>();
    const released = vi.fn();
    const App = () => {
      const root = section([p("shell text"), LazyBoundary(chunk.promise)]);
      registerDisposer(root, released);
      return root;
    };
    const reader = renderToReadableStream(App, { document: false }).getReader();
    const first = await reader.read();
    expect(first.value).toContain("shell text");
    expect(first.value).toContain("loading part");

    chunk.reject(new Error("chunk 404"));
    const rest = await reader.read().then(
      () => null,
      (err: Error) => err,
    );
    expect(rest).toBeInstanceOf(Error);
    expect(rest?.message).toMatch(/\[SibuJS SSR\] render failed .*chunk 404/);
    expect(((rest as Error).cause as Error).message).toBe("chunk 404");
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("errors the stream when a binding throws once the boundary's data arrives", async () => {
    // The data arrives only after the shell was read.
    const data = deferred<string>();
    const App = () =>
      section([
        p("shell"),
        Suspense({
          nodes: () => {
            const q = query("/api/part", () => data.promise);
            return div([
              span(() => {
                if (q.data() === "bad") throw new Error("cannot format bad data");
                return q.data() ?? "";
              }),
            ]);
          },
          fallback: () => p("loading part"),
        }),
      ]);
    const reader = renderToReadableStream(App, { document: false }).getReader();
    const shell = await reader.read();
    expect(shell.value).toContain("loading part");
    data.resolve("bad");
    const rest = await drain(reader);
    expect(rest.error?.message).toContain("cannot format bad data");
    // Nothing that ran into the failure was streamed as a success.
    expect(rest.chunks.join("")).not.toContain("sibu-resolved-");
  });

  it("streams normally when an enclosing ErrorBoundary claims the same failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const chunk = deferred<{ default: () => Element }>();
    const App = () =>
      section([
        p("shell text"),
        ErrorBoundary({ fallback: (err: Error) => p({ class: "recovered" }, `recovered: ${err.message}`) }, () =>
          div([LazyBoundary(chunk.promise)]),
        ),
      ]);
    const stream = renderToReadableStream(App, { document: false });
    const reading = readAll(stream);
    await delay(10);
    chunk.reject(new Error("chunk 404"));
    const { chunks, error } = await reading;
    expect(error).toBeNull();
    expect(chunks[0]).toContain("shell text");
  });

  it("fails the stream for an error raised while the consumer pauses between chunks", async () => {
    const chunk = deferred<{ default: () => Element }>();
    const slow = deferred<{ default: () => Element }>();
    const App = () =>
      section([
        p("shell"),
        LazyBoundary(slow.promise),
        Suspense({ nodes: () => div({ class: "quick" }, [p("quick part")]), fallback: () => p("…") }),
        LazyBoundary(chunk.promise),
      ]);
    const reader = renderToReadableStream(App, { document: false }).getReader();
    const shell = await reader.read();
    expect(shell.value).toContain("shell");
    // The consumer pauses; meanwhile a boundary fails.
    chunk.reject(new Error("failed while paused"));
    await delay(20);
    const outcome: Array<string | Error> = [];
    for (;;) {
      const next = await reader.read().then(
        (r) => r,
        (err: Error) => err,
      );
      if (next instanceof Error) {
        outcome.push(next);
        break;
      }
      if (next.done) break;
      outcome.push(next.value);
    }
    const failure = outcome[outcome.length - 1];
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("failed while paused");
    slow.resolve({ default: () => p("never streamed") });
  });

  it("stops the render at once when the reader cancels during pending boundary work", async () => {
    const slow = deferred<{ default: () => Element }>();
    const released = vi.fn();
    const App = () => {
      const root = section([p("shell"), LazyBoundary(slow.promise)]);
      registerDisposer(root, released);
      return root;
    };
    const reader = renderToReadableStream(App, { document: false, timeout: 60_000 }).getReader();
    await reader.read();
    const started = Date.now();
    await reader.cancel();
    // Released well before the 60 s boundary deadline.
    for (let i = 0; i < 100 && released.mock.calls.length === 0; i++) await delay(10);
    expect(released).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
    slow.resolve({ default: () => p("late") });
  });

  it("still streams successful boundaries out of order, then the state", async () => {
    const App = () =>
      section([
        p("shell"),
        Suspense({
          nodes: () => {
            const q = query("/api/ok", () => delay(10).then(() => "ok data"));
            return div({ class: "ok" }, [span(() => q.data() ?? "")]);
          },
          fallback: () => p("loading ok"),
        }),
      ]);
    const { chunks, error } = await readAll(renderToReadableStream(App));
    expect(error).toBeNull();
    const all = chunks.join("");
    expect(chunks[0]).toContain("loading ok");
    expect(all).toContain("ok data");
    expect(all).toContain("window.__SIBU_TRANSFER__=");
    expect(all.trim().endsWith("</html>")).toBe(true);
  });

  it("inserts a fallback holding `$&` / `$'` literally", async () => {
    // The boundary's data arrives only once the shell has been read, so the
    // shell always carries the fallback.
    const data = deferred<string>();
    const App = () =>
      section([
        p("shell"),
        Suspense({
          nodes: () => {
            const q = query("/api/price", () => data.promise);
            return div([span(() => q.data() ?? "")]);
          },
          fallback: () => p("Price $& and $' and $` and $$"),
        }),
      ]);
    const reader = renderToReadableStream(App, { document: false }).getReader();
    const shell = (await reader.read()).value ?? "";
    data.resolve("x");
    while (!(await reader.read()).done) {}
    expect(shell).toContain(">Price $&amp; and $' and $` and $$</p></div></section>");
    expect(shell).not.toContain("sibu-fallback");
  });
});
