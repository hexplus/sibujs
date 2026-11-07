import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { registerDisposer } from "../../src/core/rendering/dispose";
import { div, span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { Head } from "../../src/platform/head";
import { renderToReadableStream } from "../../src/platform/ssr";
import { renderToStringAsync } from "../../src/platform/ssrAsync";

// A server render owns the root it builds from the moment the factory starts:
// a factory that throws after allocating releases what it registered, and a
// root that was built is released exactly once however the render ends.

afterEach(() => {
  setRuntimeErrorHandler(null);
});

/** A root that allocates a reactive element and a cleanup, then throws. */
function failingRoot(value: () => number, stats: { runs: number; cleanups: number }) {
  return () => {
    const el = div(() => {
      stats.runs++;
      return String(value());
    });
    registerDisposer(el, () => stats.cleanups++);
    span(() => {
      stats.runs++;
      return String(value());
    });
    throw new Error("root fail");
  };
}

async function drain(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += value;
  }
}

describe("async SSR root ownership", () => {
  it("rolls back registrations when the root factory throws", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    await expect(renderToStringAsync(failingRoot(value, stats))).rejects.toThrow("root fail");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("releases a built root once when an error escapes the tree after construction", async () => {
    setRuntimeErrorHandler(() => {});
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    await expect(
      renderToStringAsync(() => {
        const [bad, setBad] = signal(false);
        const el = div(() => {
          stats.runs++;
          value();
          if (bad()) throw new Error("late fail");
          return "ok";
        });
        registerDisposer(el, () => stats.cleanups++);
        queueMicrotask(() => setBad(true));
        return el;
      }),
    ).rejects.toThrow();
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("releases a built root once when collecting the head throws", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    await expect(
      renderToStringAsync(() => {
        const el = div(() => {
          stats.runs++;
          return String(value());
        }, [
          Head({
            title: () => {
              throw new Error("head fail");
            },
          }),
        ]);
        registerDisposer(el, () => stats.cleanups++);
        return el;
      }),
    ).rejects.toThrow("head fail");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("releases a successful render's root once it is serialized", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const r = await renderToStringAsync(() => {
      const el = div(() => {
        stats.runs++;
        return `v${value()}`;
      });
      registerDisposer(el, () => stats.cleanups++);
      return el;
    });
    expect(r.html).toContain("v0");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("a failing request does not disturb a concurrent successful one", async () => {
    const [value, setValue] = signal(0);
    const failed = { runs: 0, cleanups: 0 };
    let okCleanups = 0;
    const [bad, good] = await Promise.allSettled([
      renderToStringAsync(failingRoot(value, failed)),
      renderToStringAsync(() => {
        const el = div(() => `ok${value()}`);
        registerDisposer(el, () => okCleanups++);
        return el;
      }),
    ]);
    expect(bad.status).toBe("rejected");
    expect(good.status).toBe("fulfilled");
    expect(good.status === "fulfilled" && good.value.html).toContain("ok0");
    expect(failed.cleanups).toBe(1);
    expect(okCleanups).toBe(1);
    const before = failed.runs;
    setValue(1);
    expect(failed.runs).toBe(before);
  });
});

describe("streaming SSR root ownership", () => {
  it("rolls back registrations when the root factory throws", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const stream = renderToReadableStream(failingRoot(value, stats), { document: false });
    await expect(stream.getReader().read()).rejects.toThrow();
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("releases a successful stream's root once it ends", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const html = await drain(
      renderToReadableStream(
        () => {
          const el = div(() => {
            stats.runs++;
            return `v${value()}`;
          });
          registerDisposer(el, () => stats.cleanups++);
          return el;
        },
        { document: false },
      ),
    );
    expect(html).toContain("v0");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("a failing stream does not disturb a concurrent successful one", async () => {
    const [value, setValue] = signal(0);
    const failed = { runs: 0, cleanups: 0 };
    const [bad, good] = await Promise.allSettled([
      drain(renderToReadableStream(failingRoot(value, failed), { document: false })),
      drain(renderToReadableStream(() => div(() => `ok${value()}`), { document: false })),
    ]);
    expect(bad.status).toBe("rejected");
    expect(good.status === "fulfilled" && good.value).toContain("ok0");
    expect(failed.cleanups).toBe(1);
    const before = failed.runs;
    setValue(1);
    expect(failed.runs).toBe(before);
  });
});
