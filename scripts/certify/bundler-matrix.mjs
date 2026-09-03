// ---------------------------------------------------------------------------
// Certification gate: bundler matrix + tree-shaking evidence.
//
//   node scripts/certify/bundler-matrix.mjs <workdir> <tarball>
//
// Materialises a throwaway consumer project, installs the PACKED tarball (never
// a workspace link), then for each bundler × each probe:
//
//   * production bundle succeeds
//   * the bundled output still RUNS (this is the `sideEffects: false` gate —
//     if a bundler dropped the reactive runtime's Symbol.for registry
//     initialisation, the probe prints BROKEN or throws)
//   * unrelated subsystems are absent from the output (tree-shaking gate)
//   * bundle size is recorded
//
// Emits a JSON report next to the workdir and a human table on stdout.
// Exit code 0 = PASS.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const [, , workdirArg, tarballArg] = process.argv;
if (!workdirArg || !tarballArg) {
  console.error("usage: node bundler-matrix.mjs <workdir> <tarball>");
  process.exit(2);
}
const WORK = resolve(workdirArg);
const TARBALL = resolve(tarballArg);

const PROBES = ["core-minimal", "data-only", "router-only", "external-only", "islands-only"];

// Markers proving a subsystem is present in bundled output. Each is a string
// that only that subsystem emits, checked against the *minified* production
// bundle so it survives renaming. Symbol.for keys are ideal: they are string
// literals the minifier must preserve verbatim.
// NOTE on `ssr`: an earlier revision used `Symbol.for("sibujs.ssr.v1")` as the
// SSR marker and reported an SSR leak into every probe. That symbol belongs to
// `src/core/ssr-context.ts` — a *core rendering* concern that core legitimately
// carries — not to the SSR renderer in `src/platform/ssr.ts`. The marker below
// is a literal only the renderer emits. (See rc-findings TEST-002.)
const SUBSYSTEM_MARKERS = {
  router: "sibujs.router.v1",
  query: "sibujs.query.cache.v1",
  islands: "sibujs.islands.registry.v1",
  "ssr-renderer": "data-sibu-suspense-id",
  i18n: "sibujs.i18n.v1",
  devtools: "sibujs.devtools.state.v1",
  dialog: "sibujs.dialog.v1",
  wasm: "sibujs.wasm.moduleCache.v1",
};

// What each probe is ALLOWED to pull in. Anything else present is a
// tree-shaking failure worth reporting (not necessarily a hard fail — public
// entrypoints legitimately aggregate modules; see the report notes).
const EXPECTED_SUBSYSTEMS = {
  "core-minimal": [],
  "data-only": ["query"],
  "router-only": ["router"],
  // `external()` is a core signal primitive. A page integrating a canvas or an
  // editor with it must not be charged for the island runtime.
  "external-only": [],
  // The progressive-enhancement entry point brings the island registry and
  // nothing else — this is the claim "adopt one widget at a time" rests on.
  "islands-only": ["islands"],
};

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    cwd: WORK,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
    ...opts,
  });

// --- set up the consumer project -------------------------------------------
mkdirSync(WORK, { recursive: true });
writeFileSync(
  join(WORK, "package.json"),
  JSON.stringify({ name: "rc-bundler-matrix", version: "1.0.0", type: "module", private: true }, null, 2),
);
mkdirSync(join(WORK, "probes"), { recursive: true });
for (const p of PROBES) cpSync(join(REPO, "fixtures/rc/probes", `${p}.js`), join(WORK, "probes", `${p}.js`));

console.log("installing packed tarball + bundlers into a clean consumer project...");
run("npm", [
  "install",
  TARBALL,
  "vite@^7",
  "rollup@^4",
  "@rollup/plugin-node-resolve@^16",
  "esbuild@^0.25",
  "webpack@^5",
  "webpack-cli@^6",
  "--no-audit",
  "--no-fund",
]);

// --- bundler drivers --------------------------------------------------------
// All target `node` so the bundled output can be executed directly for the
// runtime smoke; tree-shaking behaviour is the same machinery either way.
const BUNDLERS = {
  esbuild: (probe, out) => {
    run("npx", [
      "esbuild",
      `probes/${probe}.js`,
      "--bundle",
      "--minify",
      "--format=esm",
      "--platform=node",
      `--outfile=${out}`,
    ]);
  },
  rollup: (probe, out) => {
    const cfg = join(WORK, `rollup.${probe}.mjs`);
    writeFileSync(
      cfg,
      `import { nodeResolve } from "@rollup/plugin-node-resolve";
export default {
  input: "probes/${probe}.js",
  output: { file: ${JSON.stringify(out)}, format: "esm" },
  plugins: [nodeResolve({ exportConditions: ["node", "import"] })],
  treeshake: { moduleSideEffects: false },
  onwarn(w, warn) { if (w.code === "CIRCULAR_DEPENDENCY") return; warn(w); },
};`,
    );
    run("npx", ["rollup", "-c", cfg]);
  },
  vite: (probe, out) => {
    const cfg = join(WORK, `vite.${probe}.mjs`);
    writeFileSync(
      cfg,
      `export default {
  build: {
    ssr: "probes/${probe}.js",
    minify: "esbuild",
    outDir: ${JSON.stringify(dirname(out))},
    emptyOutDir: false,
    rollupOptions: { output: { entryFileNames: ${JSON.stringify(`${probe}.vite.js`)} } },
  },
  ssr: { noExternal: true },
  logLevel: "error",
};`,
    );
    run("npx", ["vite", "build", "-c", cfg]);
  },
  webpack: (probe, out) => {
    const cfg = join(WORK, `webpack.${probe}.cjs`);
    writeFileSync(
      cfg,
      `const path = require("path");
module.exports = {
  mode: "production",
  target: "node",
  entry: "./probes/${probe}.js",
  output: { path: path.dirname(${JSON.stringify(out)}), filename: path.basename(${JSON.stringify(out)}), module: true, chunkFormat: "module" },
  experiments: { outputModule: true },
  optimization: { usedExports: true, sideEffects: true, minimize: true },
  resolve: { conditionNames: ["node", "import", "default"] },
  stats: "errors-warnings",
};`,
    );
    run("npx", ["webpack", "--config", cfg]);
  },
};

// --- execute ----------------------------------------------------------------
mkdirSync(join(WORK, "out"), { recursive: true });
const report = [];

for (const bundler of Object.keys(BUNDLERS)) {
  for (const probe of PROBES) {
    const outName = bundler === "vite" ? `${probe}.vite.js` : `${probe}.${bundler}.js`;
    const out = join(WORK, "out", outName);
    const row = { bundler, probe, build: "FAIL", runtime: "NOT TESTED", bytes: null, extra: [], warnings: "" };

    try {
      BUNDLERS[bundler](probe, out);
      row.build = "PASS";
    } catch (err) {
      row.buildError = String(err.stderr || err.stdout || err.message).slice(0, 600);
      report.push(row);
      continue;
    }

    if (!existsSync(out)) {
      row.build = "FAIL";
      row.buildError = "bundler reported success but produced no output file";
      report.push(row);
      continue;
    }
    row.bytes = statSync(out).size;

    // Runtime smoke — this is the `sideEffects: false` gate. A bundler that
    // dropped required initialisation makes the probe print BROKEN or throw.
    //
    // `exits` is a separate gate from `runtime`: a probe can produce a correct
    // result and still pin the event loop with an un-unref'd handle. Conflating
    // the two is how RC-002 first showed up here as a confusing "FAIL" on a row
    // whose captured output said OK.
    try {
      const stdout = run("node", [out], { timeout: 15_000 });
      row.runtime = /SIBU_PROBE \S+ OK/.test(stdout) ? "PASS" : "FAIL";
      row.exits = "PASS";
      row.runtimeOut = stdout.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
    } catch (err) {
      const captured = String(err.stdout || "");
      const timedOut = err.code === "ETIMEDOUT" || err.signal === "SIGTERM" || err.killed;
      row.runtime = /SIBU_PROBE \S+ OK/.test(captured) ? "PASS" : "FAIL";
      row.exits = timedOut ? "FAIL (event loop pinned)" : "FAIL";
      row.runtimeOut = String(err.stdout || err.stderr || err.message).trim().slice(0, 300);
    }

    // tree-shaking — which subsystems leaked into a probe that never asked for them
    const code = readFileSync(out, "utf8");
    const present = Object.entries(SUBSYSTEM_MARKERS)
      .filter(([, marker]) => code.includes(marker))
      .map(([name]) => name);
    row.extra = present.filter((n) => !EXPECTED_SUBSYSTEMS[probe].includes(n));
    row.present = present;

    report.push(row);
  }
}

// --- report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(
  `\n${pad("bundler", 9)}${pad("probe", 15)}${pad("build", 7)}${pad("runtime", 9)}${pad("exits", 24)}${pad("bytes", 9)}unexpected subsystems`,
);
console.log("-".repeat(108));
for (const r of report) {
  console.log(
    pad(r.bundler, 9) +
      pad(r.probe, 15) +
      pad(r.build, 7) +
      pad(r.runtime, 9) +
      pad(r.exits ?? "-", 24) +
      pad(r.bytes ?? "-", 9) +
      (r.extra.length ? r.extra.join(", ") : "none"),
  );
  if (r.buildError) console.log(`   build error: ${r.buildError.split("\n")[0]}`);
  if (r.runtime === "FAIL") console.log(`   runtime: ${r.runtimeOut}`);
}

writeFileSync(join(WORK, "bundler-report.json"), JSON.stringify(report, null, 2));

const buildFails = report.filter((r) => r.build !== "PASS");
const runFails = report.filter((r) => r.build === "PASS" && r.runtime !== "PASS");
const exitFails = report.filter((r) => r.build === "PASS" && r.exits !== "PASS");
const shakeFails = report.filter((r) => r.extra.length > 0);
const built = report.length - buildFails.length;

console.log(`\nbuilds:        ${built}/${report.length} PASS`);
console.log(`runtime:       ${built - runFails.length}/${built} PASS`);
console.log(`clean exit:    ${built - exitFails.length}/${built} PASS`);
console.log(`tree-shaking:  ${report.length - shakeFails.length}/${report.length} clean`);
const hardFail = buildFails.length || runFails.length || exitFails.length;
console.log(hardFail ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(hardFail ? 1 : 0);
