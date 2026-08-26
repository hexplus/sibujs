// RC-003: a plain (non-`async`) function returning a Promise is a valid
// `AsyncComponent`, but the runtime dropped its promise.
//
// The public, exported type is `AsyncComponent = () => Promise<Element>`, and
// `AsyncRoute.component` accepts it. The runtime, however, classified components
// syntactically: `ComponentLoader.isAsyncComponent()` recognises only the
// `lazy()` marker, a genuine `async function`, and a source string containing
// `import(`. A component written as `() => new Promise(...)` or
// `() => fetchThing().then(...)` matched none of those, so it took the
// *synchronous* path:
//
//   const result = comp();                       // a Promise, not an Element
//   if (!this.isElement(result)) throw new Error(`... must return Element`);
//
// Two consequences, both user-visible:
//   1. the route failed with a misleading "must return Element, got object";
//   2. the promise was discarded with no handler attached, so if it later
//      rejected the rejection escaped as an *unhandled rejection* — which
//      terminates a Node process under the default policy and fires
//      `window.onunhandledrejection` in browsers.
//
// The fix adopts a thenable result instead of dropping it. It cannot regress
// anything: that branch previously always threw.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteDef } from "../src/plugins/router";
import { createRouter, destroyRouter, Route } from "../src/plugins/router";

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const settle = async () => {
  await flush();
  await new Promise((r) => setTimeout(r, 20));
};

const el = (text: string) => {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
};

let host: HTMLElement;
let rejections: unknown[];
let onRejection: (e: unknown) => void;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.appendChild(host);
  rejections = [];
  onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
});

afterEach(() => {
  process.off("unhandledRejection", onRejection);
  destroyRouter();
  host.remove();
});

describe("promise-returning route components (non-`async` syntax)", () => {
  it("renders a component that returns a Promise<Element>", async () => {
    const routes: RouteDef[] = [
      { path: "/", component: () => el("home") },
      // Deliberately NOT an `async` function — a plain arrow returning a promise.
      { path: "/p", component: () => Promise.resolve(el("promised")) },
    ];
    const router = createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await settle();

    await router.push("/p").catch(() => {});
    await settle();

    expect(host.textContent).toContain("promised");
  });

  it("does not leak an unhandled rejection when such a component rejects", async () => {
    let reject!: (e: Error) => void;
    const routes: RouteDef[] = [
      { path: "/", component: () => el("home") },
      {
        path: "/p",
        component: () =>
          new Promise<Element>((_resolve, r) => {
            reject = r;
          }),
      },
    ];
    const router = createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await settle();

    void router.push("/p").catch(() => {});
    await settle();

    reject(new Error("component load failed"));
    await settle();

    expect(rejections, `escaped rejections: ${rejections.map(String).join(", ")}`).toEqual([]);
  });

  it("does not leak an unhandled rejection when such a component is superseded first", async () => {
    let reject!: (e: Error) => void;
    const routes: RouteDef[] = [
      { path: "/", component: () => el("home") },
      {
        path: "/p",
        component: () =>
          new Promise<Element>((_resolve, r) => {
            reject = r;
          }),
      },
      { path: "/other", component: () => el("other") },
    ];
    const router = createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await settle();

    void router.push("/p").catch(() => {});
    await flush();
    void router.push("/other").catch(() => {}); // supersede while in flight
    await settle();

    reject(new Error("superseded load failed"));
    await settle();

    expect(rejections, `escaped rejections: ${rejections.map(String).join(", ")}`).toEqual([]);
    expect(router.currentRoute.path).toBe("/other");
    expect(host.textContent).toContain("other");
  });

  it("still rejects a component that returns a non-Element, non-promise value", async () => {
    const routes: RouteDef[] = [
      { path: "/", component: () => el("home") },
      // Deliberately invalid: neither an Element nor a thenable.
      { path: "/bad", component: (() => 42) as unknown as () => Element },
    ];
    const router = createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await settle();

    await router.push("/bad").catch(() => {});
    await settle();

    expect(host.textContent).not.toContain("42");
  });
});
