// Tree-shaking + `sideEffects: false` probe: ISLANDS / ENHANCEMENT ONLY.
//
// The progressive-enhancement entry point is the one people put on a page that
// is otherwise not a SibuJS app. It must bring the island registry and nothing
// else — no router, no query cache, no i18n, no dialog stack, no wasm loader.
//
// It runs without a DOM: `mountIslands(null)` is the documented no-op, which is
// also the smoke test that the module initialised at all.
import { enhance, external, mountIslands, registerIsland, signal } from "sibujs";

registerIsland("probe", (ctx) => {
  const [n] = signal(0);
  ctx.text("@n", () => n());
});

const dispose = mountIslands(null);
dispose();
dispose();

const ok =
  typeof enhance === "function" &&
  typeof external === "function" &&
  typeof registerIsland === "function" &&
  typeof dispose === "function";
console.log(`SIBU_PROBE islands-only ${ok ? "OK" : "BROKEN"}`);
if (!ok) process.exit?.(1);
