import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdnUrls, generateImportMap } from "../src/build/cdn";
import { sibuVitePlugin } from "../src/build/vite";
import { offlineStore, type SyncAdapter, type SyncConflict } from "../src/data/offlineStore";
import { clearQueryCache, query, setQueryData } from "../src/data/query";
import { renderToString } from "../src/platform/ssr";
import { createMemoryRouter, createRouter, destroyRouter } from "../src/plugins/router";
import { scopedStyle } from "../src/ui/scopedStyle";

const tick = () => new Promise((r) => setTimeout(r, 0));
const SVG_NS = "http://www.w3.org/2000/svg";
const cmp = () => document.createElement("div");

interface Todo extends Record<string, unknown> {
  id: string;
  text: string;
}

// ─── SD-1 ────────────────────────────────────────────────────────────────────

describe("SD-1: aborting one subscriber's fetch does not wedge others", () => {
  beforeEach(() => clearQueryCache());

  it("clears fetching and refetches when the owning subscriber aborts", async () => {
    let calls = 0;
    const fetcher = ({ signal }: { signal: AbortSignal; key: string }) =>
      new Promise<string>((resolve, reject) => {
        calls++;
        const c = calls;
        if (c === 1) {
          // A's fetch: reject only when aborted.
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        } else {
          resolve(`data-${c}`);
        }
      });

    const a = query("shared", fetcher, { retry: { maxRetries: 0 } });
    const b = query("shared", fetcher, { retry: { maxRetries: 0 } });
    await tick();

    expect(calls).toBe(1); // A fetched, B deduped onto A's in-flight promise
    expect(b.fetching()).toBe(true);

    a.dispose(); // aborts A's fetch -> shared promise rejects
    await tick();
    await tick();

    // Previously B stayed fetching forever; now it recovers and refetches.
    expect(b.fetching()).toBe(false);
    expect(b.data()).toBe("data-2");
    b.dispose();
  });
});

// ─── SD-2 ────────────────────────────────────────────────────────────────────

describe("SD-2: hash mode writes location.hash, not the pathname", () => {
  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    window.history.replaceState({}, "", "/");
  });

  it("updates the hash and leaves the pathname intact", async () => {
    window.history.replaceState({}, "", "/");
    const r = createRouter([{ path: "/", component: cmp }, { path: "/about", component: cmp }], { mode: "hash" });
    await r.push("/about");
    expect(window.location.hash).toBe("#/about");
    expect(window.location.pathname).toBe("/");
  });
});

// ─── SD-3 / SD-4 ─────────────────────────────────────────────────────────────

describe("SD-3/SD-4: memory router", () => {
  it("honors _initialPath instead of reading window.location", async () => {
    const m = createMemoryRouter([{ path: "/", component: cmp }, { path: "/foo", component: cmp }], "/foo");
    await m.ready;
    expect(m.currentPath()).toBe("/foo");
    m.router.destroy();
  });

  it("resolves a nested named route to its full indexed path", async () => {
    const routes = [
      {
        path: "/users",
        name: "users",
        component: cmp,
        children: [{ path: "/profile", name: "profile", component: cmp }],
      },
    ];
    const m = createMemoryRouter(routes, "/");
    await m.ready;
    await m.router.navigate({ name: "profile" });
    expect(m.router.currentRoute.path).toBe("/users/profile");
    m.router.destroy();
  });
});

// ─── SD-5 ────────────────────────────────────────────────────────────────────

describe("SD-5: a stale navigation cannot commit over a newer one", () => {
  it("does not clobber the committed route when a slow guard resolves late", async () => {
    let releaseGuard: () => void = () => {};
    const slowGuard = () => new Promise<boolean>((resolve) => (releaseGuard = () => resolve(true)));
    const routes = [
      { path: "/", component: cmp },
      { path: "/slow", component: cmp, beforeEnter: slowGuard },
      { path: "/fast", component: cmp },
    ];
    const m = createMemoryRouter(routes, "/");
    await m.ready;

    const navA = m.router.navigate("/slow"); // parks on the slow guard
    await tick();
    const navB = m.router.navigate("/fast"); // aborts A, commits immediately
    await navB;
    expect(m.router.currentRoute.path).toBe("/fast");

    releaseGuard(); // A's guard finally resolves
    await navA;
    await tick();
    expect(m.router.currentRoute.path).toBe("/fast"); // A did NOT overwrite B
    m.router.destroy();
  });
});

// ─── SD-6 ────────────────────────────────────────────────────────────────────

describe("SD-6: SSR serializes SVG rather than flattening it to text", () => {
  it("renders the svg subtree with its attributes and children", () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 10 10");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);

    const html = renderToString(svg as unknown as Node);
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 10 10"');
    expect(html).toContain("<path");
    expect(html).toContain('d="M0 0 L10 10"');
  });
});

// ─── SD-7 / SD-8 ─────────────────────────────────────────────────────────────

describe("SD-7/SD-8: build tier uses the real package name and emits plain JS", () => {
  it("cdn helpers reference sibujs and the real dist subpaths", () => {
    expect(cdnUrls.unpkg("4.0.0-alpha.0")).toBe("https://unpkg.com/sibujs@4.0.0-alpha.0/dist/cdn.global.js");
    const map = generateImportMap().imports;
    expect(map.sibujs).toContain("/dist/index.js");
    expect(map["sibujs/data"]).toContain("/dist/data.js");
    expect(map.sibujs).not.toContain("/sibu@");
    expect(Object.keys(map)).not.toContain("sibu");
  });

  it("vite plugin injects a plain-JS dev flag for sibujs imports (no TS cast)", () => {
    const plugin = sibuVitePlugin({
      devMode: true,
      pureAnnotations: false,
      staticOptimize: false,
      compileTemplates: false,
    });
    const result = plugin.transform?.(`import { div } from "sibujs";\nexport const x = div();`, "/app/foo.js");
    expect(result).not.toBeNull();
    expect(result?.code).toContain("globalThis.__SIBU_DEV__ = true");
    expect(result?.code).not.toContain("as unknown as");
  });
});

// ─── SD-9 ────────────────────────────────────────────────────────────────────

describe("SD-9: offlineStore honors conflictStrategy", () => {
  let dbn = 0;
  const freshName = () => `conflict-${dbn++}`;

  // A rejected push keeps the local change queued, so it collides with the
  // pulled remote row and the strategy actually gets exercised.
  const makeAdapter = (strategy: SyncAdapter<Todo>["conflictStrategy"], onConflict?: SyncAdapter<Todo>["onConflict"]): SyncAdapter<Todo> => ({
    push: async () => ({ ok: false }),
    pull: async () => [{ id: "1", text: "server" }],
    conflictStrategy: strategy,
    onConflict,
  });

  it("server-wins applies the remote row and drops the local pending change", async () => {
    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter: makeAdapter("server-wins") });
    await store.put({ id: "1", text: "local" });
    await store.sync();
    expect(store.data()).toEqual([{ id: "1", text: "server" }]);
    expect(store.pendingCount()).toBe(0);
    store.close();
  });

  it("client-wins keeps the local pending edit", async () => {
    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter: makeAdapter("client-wins") });
    await store.put({ id: "1", text: "local" });
    await store.sync();
    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });

  it("manual surfaces conflicts and preserves local data", async () => {
    const conflicts: SyncConflict<Todo>[] = [];
    const store = await offlineStore<Todo>({
      name: freshName(),
      autoSync: false,
      adapter: makeAdapter("manual", (c) => conflicts.push(...c)),
    });
    await store.put({ id: "1", text: "local" });
    await store.sync();
    expect(conflicts).toEqual([{ local: { id: "1", text: "local" }, remote: { id: "1", text: "server" } }]);
    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });
});

// ─── Minor 15 / Minor 23 ─────────────────────────────────────────────────────

describe("minor fixes", () => {
  it("minor 15: setQueryData clears a prior error", async () => {
    clearQueryCache();
    const q = query(
      "e15",
      async () => {
        throw new Error("boom");
      },
      { retry: { maxRetries: 0 } },
    );
    await tick();
    await tick();
    expect(q.error()).toBeInstanceOf(Error);

    setQueryData("e15", "recovered");
    expect(q.data()).toBe("recovered");
    expect(q.error()).toBeUndefined();
    q.dispose();
  });

  it("minor 23: scopedStyle scopes selectors that merely start with 'to'/'from'", () => {
    const { scope, attr } = scopedStyle(".toolbar { color: red }");
    const styleEl = document.head.querySelector(`[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).toContain(`.toolbar[${attr}]`);
  });
});
