import { type Entrypoints, interopSuite } from "./entrypoint-interop.scenarios";

// ---------------------------------------------------------------------------
// The published ES module entry points (dist/index.js + dist/plugins.js),
// which share their chunks: the same scenarios as the CommonJS ones, which
// must keep passing here. Nothing from source is loaded in this file. Needs a
// build (`npm run build`), as every dist suite.
// ---------------------------------------------------------------------------

// A fresh page: no registry left by anything else in this worker.
for (const key of Object.getOwnPropertySymbols(globalThis)) {
  if (Symbol.keyFor(key)?.startsWith("sibujs.")) delete (globalThis as Record<symbol, unknown>)[key];
}

const load = async (): Promise<Entrypoints> => ({
  // Typed through the scenarios' type-only imports of the source entry points.
  core: (await import("../dist/index.js")) as unknown as Entrypoints["core"],
  plugins: (await import("../dist/plugins.js")) as unknown as Entrypoints["plugins"],
});

interopSuite("ES module entry points (dist/index.js + dist/plugins.js)", load);
