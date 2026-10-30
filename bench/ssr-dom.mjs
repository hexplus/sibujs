// Server render cost on three DOMs: the built-in server DOM, jsdom, happy-dom.
//
//   node --expose-gc bench/ssr-dom.mjs [renders=1000]
//
// Each mode runs in its own child process so module state and heap do not
// leak between them. A mode bundles `bench/ssr-dom.entry.ts` (the fixture
// landing page from `fixtures/ssr-app`) from source with esbuild, registers its
// DOM once, then awaits `renderToStringAsync` N times. Reported: total and
// per-render time, heap growth from registering the DOM, and heap after N
// renders (both measured after a forced GC).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "node_modules", ".cache", "sibu-bench");
const renders = Number(process.argv[2] ?? 1000);
const mode = process.env.SIBU_BENCH_MODE;

if (!mode) {
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(here, "ssr-dom.entry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(out, "ssr-dom.entry.mjs"),
    external: ["jsdom", "happy-dom"],
    define: { __SIBU_DEV__: "false" },
    logLevel: "error",
  });
  const rows = [];
  for (const m of ["server", "jsdom", "happy-dom"]) {
    const json = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), String(renders)], {
      env: { ...process.env, SIBU_BENCH_MODE: m, NODE_ENV: "production" },
      encoding: "utf8",
    });
    rows.push(JSON.parse(json.trim().split("\n").pop()));
  }
  const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\nServer render, fixture landing page, ${renders} renders (Node ${process.versions.node})\n`);
  console.log("| DOM | total | per render | heap: DOM registered | heap: after renders | HTML bytes |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.mode} | ${r.totalMs.toFixed(0)} ms | ${(r.totalMs / renders).toFixed(2)} ms | ${mb(r.heapDom)} | ${mb(r.heapAfter)} | ${r.bytes} |`,
    );
  }
  writeFileSync(join(out, "ssr-dom.json"), JSON.stringify(rows, null, 2));
} else {
  const gc = globalThis.gc ?? (() => {});
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  if (mode === "jsdom") {
    const { JSDOM } = await import("jsdom");
    register(new JSDOM("").window);
  } else if (mode === "happy-dom") {
    const { Window } = await import("happy-dom");
    register(new Window());
  }
  const entry = await import(pathToFileURL(join(out, "ssr-dom.entry.mjs")).href);
  if (mode === "server") entry.installServerDom();
  gc();
  const heapDom = process.memoryUsage().heapUsed - heap0;
  // Warm-up, then measure.
  let html = "";
  for (let i = 0; i < 20; i++) html = await entry.renderLanding();
  const start = performance.now();
  for (let i = 0; i < renders; i++) html = await entry.renderLanding();
  const totalMs = performance.now() - start;
  gc();
  const heapAfter = process.memoryUsage().heapUsed - heap0;
  console.log(JSON.stringify({ mode, totalMs, heapDom, heapAfter, bytes: Buffer.byteLength(html) }));
}

function register(window) {
  for (const key of ["window", "document", "Node", "Element", "HTMLElement", "DocumentFragment", "SVGElement", "Text", "Comment", "MutationObserver", "NodeFilter"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
  }
}
