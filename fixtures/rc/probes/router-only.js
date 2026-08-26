// Tree-shaking + `sideEffects: false` probe: ROUTER ONLY.
// Imports from `sibujs/plugins` (the real router subpath — there is no
// `sibujs/router`). Runs DOM-less, which also serves as an end-to-end check of
// RC-001 through the packed artifact: before that fix this probe crashed the
// process from a microtask that no try/catch could intercept.
import { createRouter, destroyRouter } from "sibujs/plugins";

let crashed = false;
process.on?.("uncaughtException", (e) => {
  crashed = true;
  console.log(`SIBU_PROBE router-only BROKEN uncaught=${e.name}: ${e.message}`);
  process.exit(1);
});

const router = createRouter([
  { path: "/", component: () => null },
  { path: "/about", component: () => null },
]);

setTimeout(() => {
  const ok = !crashed && router.isReady === true && router.currentRoute.path === "/";
  console.log(
    `SIBU_PROBE router-only ${ok ? "OK" : "BROKEN"} ready=${router.isReady} path=${router.currentRoute.path}`,
  );
  destroyRouter();
  if (!ok) process.exit?.(1);
}, 60);
