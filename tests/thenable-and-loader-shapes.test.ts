import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { lazyIsland, mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";
import { Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Two shapes the runtime recognised too narrowly.
//
// 1. An island loader that was never wrapped in `lazyIsland()` is a plain
//    function, indistinguishable at runtime from a setup — so it was CALLED as
//    one. The loader ignores its `ctx` argument, returns a promise nobody
//    awaits, and `enhance()` reports success: the island is stamped
//    `data-sibu-enhanced="true"` while its real setup never ran. The public
//    type accepted the mistake, because `IslandRegistration` admitted any
//    `IslandLoader`, branded or not.
//
// 2. `Suspense` decided "is this async?" with `instanceof Promise`, which is
//    false for a promise from another realm (an iframe, a `vm` context, a
//    polyfill) and for any ordinary thenable. Such a value was treated as a
//    DOM node, `insertBefore` threw, the boundary rendered its error branch,
//    and the element the promise later resolved to was left live and detached
//    — reactive bindings still running, attached to nothing.
// ---------------------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

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

/** `div()` returns `Element`; Suspense's props are typed `HTMLElement`. */
const el = (...args: Parameters<typeof div>): HTMLElement => div(...args) as HTMLElement;

const logged = () => [...warn.mock.calls, ...error.mock.calls].map((c) => c.map((a) => String(a)).join(" ")).join("\n");

/**
 * Compile-time half of the island fix, checked by `npm run typecheck:tests`.
 *
 * Never executed — its value is that `tsc` fails if the `@ts-expect-error`
 * stops being an error, i.e. if `IslandRegistration` ever readmits an unbranded
 * loader. The runtime tests below cover JS callers and casts that bypass this.
 */
function _islandRegistrationTypes(): void {
  const loader = () => Promise.resolve({ default: () => {} });

  // @ts-expect-error — an unwrapped loader is not a valid registration
  registerIsland("compile-unwrapped", loader);

  registerIsland("compile-wrapped", lazyIsland(loader));
  registerIsland("compile-inline", () => {});
}
void _islandRegistrationTypes;

describe("an island loader that was never wrapped in lazyIsland()", () => {
  afterEach(() => unregisterIsland("chart"));

  it("is not reported as a successfully enhanced island", async () => {
    document.body.innerHTML = `<div data-sibu-island="chart"><span data-ref="out">0</span></div>`;
    const el = document.querySelector<HTMLElement>("[data-sibu-island]");
    if (!el) throw new Error("island markup missing");

    let setupRan = false;
    // The mistake: `lazyIsland(...)` omitted. This is a loader, not a setup.
    const loader = () =>
      Promise.resolve({
        default: () => {
          setupRan = true;
        },
      });
    registerIsland("chart", loader as never);

    mountIslands(document.body);
    await flush();

    // The setup genuinely did not run — that part is unavoidable, the runtime
    // cannot know what the function meant to be.
    expect(setupRan).toBe(false);
    // What must NOT happen is claiming the island is live anyway.
    expect(el.getAttribute("data-sibu-enhanced")).not.toBe("true");
    expect(logged()).toContain("lazyIsland");
  });

  it("still enhances normally when the loader IS wrapped", async () => {
    const { lazyIsland } = await import("../src/platform/islands");
    document.body.innerHTML = `<div data-sibu-island="chart"><span data-ref="out">0</span></div>`;
    const el = document.querySelector<HTMLElement>("[data-sibu-island]");
    if (!el) throw new Error("island markup missing");

    let setupRan = false;
    registerIsland(
      "chart",
      lazyIsland(() =>
        Promise.resolve({
          default: () => {
            setupRan = true;
          },
        }),
      ),
    );

    mountIslands(document.body);
    await flush();

    expect(setupRan).toBe(true);
    expect(el.getAttribute("data-sibu-enhanced")).toBe("true");
  });

  it("still enhances normally for an ordinary inline setup", async () => {
    document.body.innerHTML = `<div data-sibu-island="chart"><span data-ref="out">0</span></div>`;
    const el = document.querySelector<HTMLElement>("[data-sibu-island]");
    if (!el) throw new Error("island markup missing");

    let setupRan = false;
    registerIsland("chart", () => {
      setupRan = true;
    });

    mountIslands(document.body);
    await flush();

    expect(setupRan).toBe(true);
    expect(el.getAttribute("data-sibu-enhanced")).toBe("true");
  });
});

describe("Suspense recognises async work by shape, not by realm", () => {
  it("awaits a cross-realm promise instead of rendering an error", async () => {
    const { runInNewContext } = await import("node:vm");
    const resolved = el("loaded");
    // A real promise built in another realm: `instanceof Promise` is false for
    // it here, but it is thenable and awaitable in every meaningful sense.
    const foreign = runInNewContext("(v) => Promise.resolve(v)")(resolved) as Promise<HTMLElement>;
    expect(foreign instanceof Promise).toBe(false);

    const host = div([Suspense({ nodes: () => foreign, fallback: () => el("loading") })]);
    document.body.appendChild(host);
    await flush();

    expect(host.querySelector(".suspense-error")).toBeNull();
    expect(host.textContent).toContain("loaded");
    // The resolved element must be IN the document, not orphaned while live.
    expect(resolved.isConnected).toBe(true);
  });

  it("awaits a plain thenable", async () => {
    const resolved = el("thenable-loaded");
    const thenable: PromiseLike<HTMLElement> = {
      // biome-ignore lint/suspicious/noThenProperty: a thenable is the subject of this test
      then(onFulfilled?: ((v: HTMLElement) => never) | null) {
        queueMicrotask(() => onFulfilled?.(resolved));
        return thenable as never;
      },
    };

    const host = div([Suspense({ nodes: () => thenable, fallback: () => el("loading") })]);
    document.body.appendChild(host);
    await flush();

    expect(host.querySelector(".suspense-error")).toBeNull();
    expect(resolved.isConnected).toBe(true);
  });

  it("inserts a DOM node that happens to expose `then` instead of awaiting it", async () => {
    // A custom element may define a `then` method. Shape alone would classify
    // it as async, leaving the boundary on its fallback forever — so the check
    // excludes anything with a numeric `nodeType`, which also covers a node
    // from another realm where `instanceof Node` would not.
    const node = el("i-am-a-node") as HTMLElement & { then?: unknown };
    // biome-ignore lint/suspicious/noThenProperty: a node with `then` is the case under test
    node.then = () => {
      throw new Error("Suspense awaited a DOM node");
    };

    const host = div([Suspense({ nodes: () => node, fallback: () => el("loading") })]);
    document.body.appendChild(host);
    await flush();

    expect(host.textContent).toContain("i-am-a-node");
    expect(host.querySelector(".suspense-error")).toBeNull();
    expect(node.isConnected).toBe(true);
  });

  it("accepts an element as the fallback, not only a function", async () => {
    let resolveIt: (v: HTMLElement) => void = () => {};
    const pending = new Promise<HTMLElement>((r) => {
      resolveIt = r;
    });

    const host = div([Suspense({ nodes: () => pending, fallback: el("waiting") })]);
    document.body.appendChild(host);
    await flush();
    expect(host.textContent).toContain("waiting");

    resolveIt(el("done"));
    await flush();
    expect(host.textContent).toContain("done");
  });

  it("still renders a synchronous element without a fallback flash", async () => {
    const host = div([Suspense({ nodes: () => el("sync"), fallback: () => el("loading") })]);
    document.body.appendChild(host);
    await flush();

    expect(host.textContent).toContain("sync");
    expect(host.textContent).not.toContain("loading");
  });

  it("still reports a rejected promise through the error branch", async () => {
    const host = div([Suspense({ nodes: () => Promise.reject(new Error("boom")), fallback: () => el("loading") })]);
    document.body.appendChild(host);
    await flush();

    expect(host.querySelector(".suspense-error")?.textContent).toBe("boom");
  });
});
