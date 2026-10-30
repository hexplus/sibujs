import { afterEach, describe, expect, it } from "vitest";
import { div, p } from "../src/core/rendering/html";
import { executeLoader, loaderData, type RouteLoaderFn, renderWithLoader } from "../src/data/routeLoader";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import { __resetTransfer } from "../src/utils/transfer";

// A loader's automatic transfer key is `loader:<path>:<function name>`. A name
// is not an identity: two different loader functions reaching the same key
// (two `loader: async () => …` properties, two anonymous loaders) make it
// ambiguous, and then NEITHER transfers — both fetch again in the browser —
// rather than one loader receiving the other's data.

afterEach(() => {
  __resetTransfer();
  delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const ctx = { params: {}, path: "/parent/child" };

/** Run the transfer script as the browser would. */
function runTransferScript(state: string): void {
  const body = /<script[^>]*>([\s\S]*)<\/script>/.exec(state)?.[1];
  if (body) new Function(body)();
  __resetTransfer();
}

function transferred(state: string): Record<string, unknown> {
  runTransferScript(state);
  const payload = (window as unknown as { __SIBU_TRANSFER__?: { r?: Record<string, unknown> } }).__SIBU_TRANSFER__;
  return payload?.r ?? {};
}

/** Two routes declaring their loader as an object property: both functions are named "loader". */
function propertyLoaders() {
  const calls = { parent: 0, child: 0 };
  const parentRoute = {
    loader: async () => {
      calls.parent++;
      return { kind: "parent" };
    },
  };
  const childRoute = {
    loader: async () => {
      calls.child++;
      return { kind: "child" };
    },
  };
  expect(parentRoute.loader.name).toBe("loader");
  expect(childRoute.loader.name).toBe("loader");
  return { calls, parent: parentRoute.loader as RouteLoaderFn<{ kind: string }>, child: childRoute.loader };
}

describe("automatic route-loader transfer keys", () => {
  it("never hands one same-named loader's result to another: both fetch again in the browser", async () => {
    const { calls, parent, child } = propertyLoaders();
    const server = await renderToStringAsync(() => {
      const a = executeLoader(parent, ctx);
      const b = executeLoader(child, ctx);
      return p(() => `${a.data()?.kind} ${b.data()?.kind}`);
    });
    expect(server.html).toContain("parent child");
    expect(Object.keys(transferred(server.state))).not.toContain("loader:/parent/child:loader");
    calls.parent = 0;
    calls.child = 0;

    const a = executeLoader(parent, ctx);
    const b = executeLoader(child, ctx);
    await tick();
    expect(a.data()).toEqual({ kind: "parent" });
    expect(b.data()).toEqual({ kind: "child" });
    expect(calls).toEqual({ parent: 1, child: 1 });
  });

  it("treats two anonymous loaders for one path the same way", async () => {
    const make = (kind: string) => [async () => ({ kind })][0];
    const first = make("first");
    const second = make("second");
    expect(first.name).toBe("");
    const server = await renderToStringAsync(() => {
      const a = executeLoader(first, ctx);
      const b = executeLoader(second, ctx);
      return p(() => `${a.data()?.kind} ${b.data()?.kind}`);
    });
    expect(server.html).toContain("first second");
    expect(transferred(server.state)).toEqual({});
    const a = executeLoader(first, ctx);
    const b = executeLoader(second, ctx);
    await tick();
    expect([a.data(), b.data()]).toEqual([{ kind: "first" }, { kind: "second" }]);
  });

  it("gives nested parent and child loaders each their own data after takeover", async () => {
    const { parent, child } = propertyLoaders();
    const App = () => {
      const outer = executeLoader(parent, ctx);
      return renderWithLoader(outer, () => {
        const mine = loaderData<{ kind: string }>();
        const inner = executeLoader(child, ctx);
        const nested = renderWithLoader(inner, () => {
          const own = loaderData<{ kind: string }>();
          return p({ class: "child" }, () => own.data()?.kind ?? "");
        });
        return div([p({ class: "parent" }, () => mine.data()?.kind ?? ""), nested]);
      });
    };
    const server = await renderToStringAsync(App);
    expect(server.html).toMatch(/class="parent"[^>]*>(<!---->)?parent</);
    expect(server.html).toMatch(/class="child"[^>]*>(<!---->)?child</);
    runTransferScript(server.state);

    const host = App() as HTMLElement;
    await tick();
    expect(host.querySelector(".parent")?.textContent).toBe("parent");
    expect(host.querySelector(".child")?.textContent).toBe("child");
  });

  it("transfers the same loader used twice under one key, and the browser reads it", async () => {
    let calls = 0;
    const shared: RouteLoaderFn<{ n: number }> = async () => ({ n: ++calls });
    const server = await renderToStringAsync(() => {
      const a = executeLoader(shared, ctx);
      const b = executeLoader(shared, ctx);
      return p(() => `${a.data()?.n} ${b.data()?.n}`);
    });
    expect(Object.keys(transferred(server.state))).toEqual(["loader:/parent/child:shared"]);
    calls = 0;
    const a = executeLoader(shared, ctx);
    await tick();
    // Started from the transferred value, without running the loader.
    expect(a.data()?.n).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  it("transfers same-named loaders that have explicit keys", async () => {
    const { calls, parent, child } = propertyLoaders();
    const server = await renderToStringAsync(() => {
      const a = executeLoader(parent, ctx, { key: "parent-data" });
      const b = executeLoader(child, ctx, { key: "child-data" });
      return p(() => `${a.data()?.kind} ${b.data()?.kind}`);
    });
    expect(transferred(server.state)).toEqual({ "parent-data": { kind: "parent" }, "child-data": { kind: "child" } });
    calls.parent = 0;
    calls.child = 0;
    const a = executeLoader(parent, ctx, { key: "parent-data" });
    const b = executeLoader(child, ctx, { key: "child-data" });
    expect(a.data()).toEqual({ kind: "parent" });
    expect(b.data()).toEqual({ kind: "child" });
    await tick();
    expect(calls).toEqual({ parent: 0, child: 0 });
  });

  it("keeps the ambiguity of one request out of a concurrent one", async () => {
    const { parent, child } = propertyLoaders();
    const [ambiguous, single] = await Promise.all([
      renderToStringAsync(() => {
        const a = executeLoader(parent, ctx);
        const b = executeLoader(child, ctx);
        return p(() => `${a.data()?.kind} ${b.data()?.kind}`);
      }),
      renderToStringAsync(() => {
        const a = executeLoader(child, ctx);
        return p(() => `${a.data()?.kind}`);
      }),
    ]);
    expect(ambiguous.html).toContain("parent child");
    expect(single.html).toContain("child");
    expect(transferred(ambiguous.state)).toEqual({});
    delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
    expect(transferred(single.state)).toEqual({ "loader:/parent/child:loader": { kind: "child" } });
  });

  it("still transfers loaders with distinct names for one path", async () => {
    async function listUsers() {
      return ["ada"];
    }
    async function listTeams() {
      return ["core"];
    }
    const server = await renderToStringAsync(() => {
      const a = executeLoader(listUsers, ctx);
      const b = executeLoader(listTeams, ctx);
      return p(() => `${a.data()?.[0]} ${b.data()?.[0]}`);
    });
    expect(transferred(server.state)).toEqual({
      "loader:/parent/child:listUsers": ["ada"],
      "loader:/parent/child:listTeams": ["core"],
    });
  });
});
