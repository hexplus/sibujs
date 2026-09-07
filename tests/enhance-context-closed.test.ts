import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhance } from "../src/platform/enhance";

// ---------------------------------------------------------------------------
// A rolled-back enhancement must stay rolled back.
//
// Detecting the thenable, draining the teardowns and throwing is only half of
// it: the async function that returned that thenable KEEPS RUNNING. Everything
// after its first `await` still holds a live `ctx`, so it can register
// listeners, bindings and cleanups into an enhancement that was already
// unwound — past the rollback, past the disposer, and with no marker on the
// root to show anything owns them. The listener works; nothing can ever remove
// it.
//
// The same escape exists without any promise at all: a setup that queues a
// microtask and then throws synchronously is unwound the same way, and its
// continuation holds the same `ctx`.
//
// The context is therefore CLOSED once its transaction has been unwound, and
// closing happens *after* the teardowns drain — a teardown may legitimately
// register another cleanup while unwinding, which is documented behaviour and
// must keep working.
// ---------------------------------------------------------------------------

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = "";
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("a rolled-back enhancement refuses later registrations", () => {
  it("ignores ctx.on() called after the await", async () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let clicks = 0;
    expect(() =>
      enhance(root, (async (ctx: import("../src/platform/enhance").EnhanceContext) => {
        await Promise.resolve();
        ctx.on(root, "click", () => {
          clicks++;
        });
      }) as never),
    ).toThrow();

    await flush();
    root.click();

    expect(root.getAttribute("data-sibu-enhanced")).not.toBe("true");
    expect(clicks).toBe(0);
  });

  it("ignores every mutating context method called after the await", async () => {
    document.body.innerHTML = `<div id="r"><span data-ref="t">server</span></div>`;
    const root = document.getElementById("r") as HTMLElement;
    const target = root.querySelector<HTMLElement>("[data-ref=t]");
    if (!target) throw new Error("fixture missing");

    let clicks = 0;
    let cleanupRan = false;
    let eachRan = false;

    expect(() =>
      enhance(root, (async (ctx: import("../src/platform/enhance").EnhanceContext) => {
        await Promise.resolve();
        ctx.on(root, "click", () => {
          clicks++;
        });
        ctx.text("@t", () => "rewritten");
        ctx.attr("@t", "data-x", () => "1");
        ctx.classed("@t", "on", () => true);
        ctx.show("@t", () => false);
        ctx.each("@t", () => {
          eachRan = true;
          return { text: () => "each" };
        });
        ctx.cleanup(() => {
          cleanupRan = true;
        });
      }) as never),
    ).toThrow();

    await flush();
    root.click();

    expect(clicks).toBe(0);
    expect(eachRan).toBe(false);
    expect(cleanupRan).toBe(false);
    // The server's DOM is untouched: no text, attribute, class or display write
    // landed from the continuation.
    expect(target.textContent).toBe("server");
    expect(target.getAttribute("data-x")).toBeNull();
    expect(target.classList.contains("on")).toBe(false);
    expect(target.hidden).toBe(false);
  });

  it("ignores a queued microtask after a synchronous setup failure", async () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let clicks = 0;
    expect(() =>
      enhance(root, (ctx) => {
        queueMicrotask(() => {
          ctx.on(root, "click", () => {
            clicks++;
          });
        });
        throw new Error("setup failed");
      }),
    ).toThrow("setup failed");

    await flush();
    root.click();
    expect(clicks).toBe(0);
  });

  it("says so in dev rather than dropping the registration silently", async () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    expect(() =>
      enhance(root, (async (ctx: import("../src/platform/enhance").EnhanceContext) => {
        await Promise.resolve();
        ctx.on(root, "click", () => {});
      }) as never),
    ).toThrow();

    await flush();
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("rolled back");
  });

  it("still lets a teardown register another cleanup while unwinding", () => {
    // Documented behaviour: `ctx.cleanup` stays reachable from inside a
    // teardown, and the drain keeps going until the list is stable. Closing the
    // context must not happen until that drain is finished.
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let nested = false;
    expect(() =>
      enhance(root, (ctx) => {
        ctx.cleanup(() => {
          ctx.cleanup(() => {
            nested = true;
          });
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(nested).toBe(true);
  });

  it("refuses registrations after an ordinary dispose() too", async () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let captured: import("../src/platform/enhance").EnhanceContext | null = null;
    let clicks = 0;
    const dispose = enhance(root, (ctx) => {
      captured = ctx;
    });
    dispose();

    (captured as unknown as import("../src/platform/enhance").EnhanceContext).on(root, "click", () => {
      clicks++;
    });
    root.click();
    expect(clicks).toBe(0);
  });

  it("does not interfere with a healthy enhancement", () => {
    document.body.innerHTML = `<div id="r"><span data-ref="t">0</span></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let clicks = 0;
    const dispose = enhance(root, (ctx) => {
      ctx.on(root, "click", () => {
        clicks++;
      });
      ctx.text("@t", () => "live");
    });

    root.click();
    expect(clicks).toBe(1);
    expect(root.querySelector("[data-ref=t]")?.textContent).toBe("live");
    dispose();
  });
});
