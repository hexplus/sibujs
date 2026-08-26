// Tree-shaking + `sideEffects: false` probe: DATA LAYER ONLY.
// Imports from `sibujs/data` and nothing else. Verifies the query cache's
// Symbol.for registry initialisation survives tree-shaking, and that pulling in
// the data layer does not drag in the router or the SSR renderer.
import { getQueryData, query, setQueryData } from "sibujs/data";

const q = query("rc-probe-key", async () => "fetched");

setTimeout(() => {
  const afterFetch = q.data();
  setQueryData("rc-probe-key", "overwritten");
  const afterWrite = getQueryData("rc-probe-key");
  q.dispose?.();

  const ok = afterFetch === "fetched" && afterWrite === "overwritten";
  console.log(
    `SIBU_PROBE data-only ${ok ? "OK" : "BROKEN"} afterFetch=${afterFetch} afterWrite=${afterWrite}`,
  );
  if (!ok) process.exit?.(1);
}, 60);
