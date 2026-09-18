import { afterEach, describe, expect, it, vi } from "vitest";
import { div, span } from "../src/core/rendering/html";
import { runInSSRContext } from "../src/core/ssr-context";
import { ssrSuspense } from "../src/platform/ssr";

// ---------------------------------------------------------------------------
// ssrSuspense() contains synchronous content failures.
//
// THE DEFECT: `props.content()` was evaluated as an argument to Promise.race(),
// so a content factory that threw synchronously escaped ssrSuspense() itself —
// crashing the request — while an asynchronous rejection of the same content was
// converted into deterministic fallback output. The timer was also cleared only
// when its handle was truthy, so a handle of 0 was never cleared.
//
// DOCUMENTED ERROR PATH: every failure to produce content HTML — a synchronous
// throw, a rejection, a timeout, or rendering the resolved element throwing —
// resolves the boundary's promise with the fallback HTML.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fallback = () => span("Loading") as HTMLElement;

async function boundary(content: () => Promise<HTMLElement>, timeoutMs?: number) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return runInSSRContext(async () => {
    const result = ssrSuspense({ fallback, content, timeoutMs });
    return { element: result.element, payload: await result.promise };
  });
}

describe("ssrSuspense failure containment", () => {
  it("a synchronous content throw resolves with the fallback HTML", async () => {
    const { element, payload } = await boundary(() => {
      throw new Error("synchronous loader failure");
    });

    expect(element.getAttribute("data-sibu-suspense-id")).toBe(payload.id);
    expect(payload.html).toContain("Loading");
  });

  it("an asynchronous rejection behaves identically", async () => {
    const sync = await boundary(() => {
      throw new Error("x");
    });
    const async = await boundary(async () => {
      throw new Error("x");
    });

    expect(async.payload.html).toBe(sync.payload.html);
  });

  it("a thenable whose `then` getter throws is contained", async () => {
    const hostile = {
      // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject of this test
      get then(): never {
        throw new Error("then getter exploded");
      },
    } as unknown as Promise<HTMLElement>;

    const { payload } = await boundary(() => hostile);

    expect(payload.html).toContain("Loading");
  });

  it("rendering the resolved element throwing resolves with the fallback HTML", async () => {
    const poisoned = div("content") as HTMLElement;
    Object.defineProperty(poisoned, "childNodes", {
      get() {
        throw new Error("render exploded");
      },
    });

    const { payload } = await boundary(async () => poisoned);

    expect(payload.html).toContain("Loading");
  });

  it("successful content still renders", async () => {
    const { payload } = await boundary(async () => div("Ready") as HTMLElement);
    expect(payload.html).toContain("Ready");
    expect(payload.html).not.toContain("Loading");
  });

  it("clears a timer whose handle is 0", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);

    const { payload } = await boundary(async () => div("Ready") as HTMLElement, 1000);

    expect(payload.html).toContain("Ready");
    expect(clear).toHaveBeenCalledWith(0);
  });
});
