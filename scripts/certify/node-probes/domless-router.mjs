// RC-001 probe: constructing a router in a DOM-less runtime must not kill the
// process from a microtask.
//
// The failure mode is asynchronous and uncatchable: the constructor returns
// normally and the process dies later. A probe that only asserts the
// constructor returned would pass against the broken build, so this installs an
// uncaughtException handler and waits for the bootstrap microtask to drain.
import { createRouter, createMemoryRouter, destroyRouter } from "sibujs/plugins";

let uncaught = null;
process.on("uncaughtException", (e) => {
  uncaught = e;
});
process.on("unhandledRejection", (e) => {
  uncaught = e instanceof Error ? e : new Error(String(e));
});

if (typeof globalThis.window !== "undefined") {
  console.log("DOMLESS_ROUTER_PROBE FAIL: a window global exists; probe is not DOM-less");
  process.exit(1);
}

const r1 = createRouter([{ path: "/", component: () => null }]);
const r2Path = (() => {
  const { currentPath } = createMemoryRouter([{ path: "/", component: () => null }], "/");
  return currentPath();
})();

// Wait well past the queueMicrotask bootstrap AND a macrotask turn.
setTimeout(() => {
  if (uncaught) {
    console.log(`DOMLESS_ROUTER_PROBE FAIL: ${uncaught.name}: ${uncaught.message}`);
    process.exit(1);
  }
  const ok = r1.isReady === true && r1.currentRoute.path === "/" && r2Path === "/";
  console.log(`DOMLESS_ROUTER_PROBE ${ok ? "PASS" : "FAIL"} ready=${r1.isReady} path=${r1.currentRoute.path} memory=${r2Path}`);
  destroyRouter();
  process.exit(ok ? 0 : 1);
}, 150);
