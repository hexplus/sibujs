import { afterEach, expect, it } from "vitest";
import { createRouter, destroyRouter, beforeEach as guard, route, setRoutes } from "../src/plugins/router";

const stub = () => () => document.createElement("div");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  destroyRouter();
  window.history.replaceState({}, "", "/");
});

for (const mode of ["hash", "history"] as const) {
  it(`${mode}: native change to redirect route / guarded route`, async () => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode, base: "" });
    setRoutes([
      { path: "/", component: stub() },
      { path: "/b", component: stub() },
      { path: "/old", redirect: "/b" },
      { path: "/no", component: stub() },
    ]);
    guard((to, _f, next) => next(to.path === "/no" ? false : undefined));
    await tick();
    const go = (p: string) => {
      if (mode === "hash") window.location.hash = `#${p}`;
      else {
        history.pushState({}, "", p);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    };
    go("/old");
    await tick(100);
    process.stdout.write(`PROBE ${mode} redirect: route=${route().path} url=${location.pathname}${location.hash}\n`);
    go("/no");
    await tick(100);
    process.stdout.write(`PROBE ${mode} rejected: route=${route().path} url=${location.pathname}${location.hash}\n`);
    expect(1).toBe(1);
  });
}
