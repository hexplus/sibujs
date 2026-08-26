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

// Wait past the queueMicrotask bootstrap AND a macrotask turn (RC-001), then
// exercise NAVIGATION, not just construction (NODE-001). Construction alone was
// green while every push/replace still failed with "history is not defined", so
// a probe that stops at the constructor proves nothing about usability.
setTimeout(async () => {
  const construction = !uncaught && r1.isReady === true && r1.currentRoute.path === "/";
  destroyRouter();

  const { router, currentPath, push } = createMemoryRouter(
    [
      { path: "/", component: () => null },
      { path: "/about", component: () => null },
    ],
    "/",
  );
  await new Promise((r) => setTimeout(r, 50));
  const startPath = currentPath();

  const pushed = await push("/about").catch((e) => ({ success: false, error: e }));
  await new Promise((r) => setTimeout(r, 20));
  const navigated = pushed?.success === true && currentPath() === "/about" && router.currentRoute.path === "/about";

  const replaced = await router.replace("/").catch(() => ({ success: false }));
  await new Promise((r) => setTimeout(r, 20));
  const replacedOk = replaced?.success === true && currentPath() === "/";

  destroyRouter();

  if (uncaught) {
    console.log(`DOMLESS_ROUTER_PROBE FAIL: ${uncaught.name}: ${uncaught.message}`);
    process.exit(1);
  }

  const ok = construction && startPath === "/" && navigated && replacedOk;
  console.log(
    `DOMLESS_ROUTER_PROBE ${ok ? "PASS" : "FAIL"} ` +
      `construction=${construction} navigate=${navigated} replace=${replacedOk} ` +
      `path=${currentPath()}${pushed?.error ? ` err=${pushed.error.message}` : ""}`,
  );
  process.exit(ok ? 0 : 1);
}, 150);
