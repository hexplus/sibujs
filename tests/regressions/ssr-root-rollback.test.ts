import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { when } from "../../src/core/rendering/directives";
import { dispose, registerDisposer, withDisposerRollback } from "../../src/core/rendering/dispose";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { runInSSRContext } from "../../src/core/ssr-context";
import { Head } from "../../src/platform/head";
import { renderToReadableStream } from "../../src/platform/ssr";
import { renderToStringAsync } from "../../src/platform/ssrAsync";
import { registerTransferCollector } from "../../src/utils/transfer";

// A server render owns the root it builds from the moment the factory starts:
// a factory that throws after allocating releases what it registered, and a
// root that was built is released exactly once however the render ends.

afterEach(() => {
  setRuntimeErrorHandler(null);
  registerTransferCollector("rollback-test", () => undefined);
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

describe("SSR root ownership on other failure paths", () => {
  it("releases the root when reading an option throws after construction", async () => {
    let cleanups = 0;
    await expect(
      renderToStringAsync(
        () => {
          const root = div("ok");
          registerDisposer(root, () => cleanups++);
          return root;
        },
        {
          get timeout(): number {
            throw new Error("timeout read");
          },
        },
      ),
    ).rejects.toThrow("timeout read");
    expect(cleanups).toBe(1);
  });

  it("releases the root when a transfer collector throws", async () => {
    let cleanups = 0;
    registerTransferCollector("rollback-test", () => {
      throw new Error("collector");
    });
    await expect(
      renderToStringAsync(() => {
        const root = div("ok");
        registerDisposer(root, () => cleanups++);
        return root;
      }),
    ).rejects.toThrow("collector");
    expect(cleanups).toBe(1);
  });

  it("releases a stream's root when its head getter throws", async () => {
    let cleanups = 0;
    await expect(
      drain(
        renderToReadableStream(
          () => {
            const root = div([
              Head({
                title: () => {
                  throw new Error("head read");
                },
              }),
              span("ok"),
            ]);
            registerDisposer(root, () => cleanups++);
            return root;
          },
          { document: false },
        ),
      ),
    ).rejects.toThrow("head read");
    expect(cleanups).toBe(1);
  });

  it("rolls back nested builds within the render, fragment-own cleanup included, once", async () => {
    const [value, setValue] = signal(0);
    let runs = 0;
    let cleanups = 0;
    let frag: DocumentFragment | undefined;
    await expect(
      renderToStringAsync(() => {
        frag = withDisposerRollback(() =>
          Fragment([
            span(() => {
              runs++;
              return String(value());
            }),
          ]),
        );
        registerDisposer(frag, () => cleanups++);
        throw new Error("outer");
      }),
    ).rejects.toThrow("outer");
    const before = runs;
    setValue(1);
    expect(runs).toBe(before);
    expect(cleanups).toBe(1);
    dispose(frag as DocumentFragment);
    expect(cleanups).toBe(1);
  });
});

describe("a failed root does not roll back a render it started", () => {
  // A render started synchronously inside another root's factory owns its
  // registrations: the outer root failing must not stop its deferred content
  // or run its cleanup early.

  /** A root with deferred content (a `when()` branch) and a cleanup. */
  function independentRoot(text: string, stats: { cleanups: number }) {
    return () => {
      const root = div([
        when(
          () => true,
          () => span(text),
        ),
      ]);
      registerDisposer(root, () => stats.cleanups++);
      return root;
    };
  }

  type AsyncResult = ReturnType<typeof renderToStringAsync>;

  it("async outer, stream inner", async () => {
    const stats = { cleanups: 0 };
    let inner: ReadableStream<string> | undefined;
    await expect(
      renderToStringAsync(() => {
        inner = renderToReadableStream(independentRoot("independent stream", stats), { document: false });
        throw new Error("outer render");
      }),
    ).rejects.toThrow("outer render");
    expect(stats.cleanups).toBe(0);
    expect(await drain(inner as ReadableStream<string>)).toContain("independent stream");
    expect(stats.cleanups).toBe(1);
  });

  it("async outer, async inner in a fresh request", async () => {
    const stats = { cleanups: 0 };
    let inner: AsyncResult | undefined;
    await expect(
      renderToStringAsync(() => {
        inner = runInSSRContext(() => renderToStringAsync(independentRoot("independent async", stats)));
        throw new Error("outer render");
      }),
    ).rejects.toThrow("outer render");
    expect(stats.cleanups).toBe(0);
    expect((await (inner as AsyncResult)).html).toContain("independent async");
    expect(stats.cleanups).toBe(1);
  });

  it("async outer, async inner in the same request", async () => {
    const stats = { cleanups: 0 };
    let inner: AsyncResult | undefined;
    await expect(
      renderToStringAsync(() => {
        inner = renderToStringAsync(independentRoot("same request", stats));
        throw new Error("outer render");
      }),
    ).rejects.toThrow("outer render");
    expect((await (inner as AsyncResult)).html).toContain("same request");
    expect(stats.cleanups).toBe(1);
  });

  it("stream outer, stream inner", async () => {
    const stats = { cleanups: 0 };
    let inner: ReadableStream<string> | undefined;
    await expect(
      drain(
        renderToReadableStream(
          () => {
            inner = renderToReadableStream(independentRoot("independent stream", stats), { document: false });
            throw new Error("outer stream");
          },
          { document: false },
        ),
      ),
    ).rejects.toThrow("outer stream");
    expect(stats.cleanups).toBe(0);
    expect(await drain(inner as ReadableStream<string>)).toContain("independent stream");
    expect(stats.cleanups).toBe(1);
  });

  it("stream outer, async inner in a fresh request", async () => {
    const stats = { cleanups: 0 };
    let inner: AsyncResult | undefined;
    await expect(
      drain(
        renderToReadableStream(
          () => {
            inner = runInSSRContext(() => renderToStringAsync(independentRoot("independent async", stats)));
            throw new Error("outer stream");
          },
          { document: false },
        ),
      ),
    ).rejects.toThrow("outer stream");
    expect(stats.cleanups).toBe(0);
    expect((await (inner as AsyncResult)).html).toContain("independent async");
    expect(stats.cleanups).toBe(1);
  });
});
