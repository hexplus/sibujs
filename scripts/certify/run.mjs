// ---------------------------------------------------------------------------
// Release-candidate certification runner.
//
//   npm run certify:rc
//
// Runs every release gate in order and prints one table. Its contract:
//
//   * a gate is PASS, FAIL, NOT SUPPORTED, or NOT TESTED
//   * "NOT TESTED" is never silently reported as "PASS" — a gate that could not
//     run (missing browsers, no network for the bundler install, a runtime that
//     is not installed) says so explicitly and is counted separately
//   * the exit code is non-zero if any REQUIRED gate failed
//
// Skipping is deliberate and visible rather than silent, because the whole
// point of the exercise is evidence: a green run that quietly omitted the
// browser matrix is worse than a red one.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const args = new Set(process.argv.slice(2));
const SKIP_BROWSER = args.has("--no-browser");
const SKIP_PACKAGE = args.has("--no-package");
const SKIP_SOAK = args.has("--no-soak");

const results = [];
const record = (gate, status, detail = "", required = true) =>
  results.push({ gate, status, detail, required });

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: REPO,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function gate(name, cmd, cmdArgs, { required = true, extract, opts } = {}) {
  process.stdout.write(`→ ${name} ... `);
  const r = run(cmd, cmdArgs, opts);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  const detail = extract ? extract(out) : "";
  record(name, ok ? "PASS" : "FAIL", detail, required);
  console.log(ok ? `PASS ${detail}` : `FAIL ${detail}`);
  if (!ok) {
    const tail = out.trim().split("\n").slice(-12).join("\n");
    console.log(tail.replace(/^/gm, "    | "));
  }
  return ok;
}

// Vitest colourises its summary, so the digits are separated from the labels by
// ANSI escapes. Strip them before matching, or every count silently comes back
// empty and the report looks like it measured nothing.
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");

const countTests = (out) => {
  const clean = stripAnsi(out);
  const m = clean.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/);
  const f = clean.match(/Test Files\s+(\d+)\s+passed/);
  if (!m) return "";
  return `${m[1]} tests${m[2] ? ` (+${m[2]} skipped)` : ""}${f ? `, ${f[1]} files` : ""}`;
};

console.log(`SibuJS release-candidate certification\nnode ${process.version} · ${process.platform}\n`);

// --- static gates -----------------------------------------------------------
//
// BUILD RUNS FIRST, and the order is load-bearing: `tests/consumption.test.ts`
// reads real files out of `dist/` (it is the suite's own packaging check), so
// running the suite against a stale or absent `dist/` reports failures that say
// nothing about the source. `npm run build` also starts with `--clean`, so a
// build that fails part-way leaves `dist/` incomplete for everything after it.
// See rc-findings TEST-007.
gate("Build", "npm", ["run", "build"]);
gate("TypeScript (src)", "npx", ["tsc", "--noEmit"]);
gate("Lint", "npx", ["biome", "check", "--max-diagnostics=500", "src/", "tests/"]);
gate("Full unit/integration suite", "npx", ["vitest", "run", "--reporter=dot"], { extract: countTests });

// `tests/` and the 15 non-index entry files. This was a NON-BLOCKING gate
// while 130 pre-existing errors were burned down (rc-findings TEST-004); it is
// now REQUIRED, because a test can only say something about the public API if
// it uses that API the way the published types permit.
gate("TypeScript (tests + entry files)", "npx", ["tsc", "-p", "tsconfig.test.json"], {
  extract: (out) => {
    const n = stripAnsi(out).split(String.fromCharCode(10)).filter((l) => /error TS/.test(l)).length;
    return n ? `${n} errors` : "0 errors";
  },
});

// --- fuzz gates -------------------------------------------------------------
gate("Query model fuzzing", "npx", ["vitest", "run", "tests/fuzz-query-model.test.ts", "--reporter=dot"], {
  extract: countTests,
});
gate("Router model fuzzing", "npx", ["vitest", "run", "tests/fuzz-router-model.test.ts", "--reporter=dot"], {
  extract: countTests,
});
gate("SSR security fuzzing", "npx", ["vitest", "run", "tests/fuzz-ssr-security.test.ts", "--reporter=dot"], {
  extract: countTests,
});

// --- browser matrix ---------------------------------------------------------
if (SKIP_BROWSER) {
  record("Browser matrix (Chromium/Firefox/WebKit)", "NOT TESTED", "skipped via --no-browser");
  console.log("→ Browser matrix ... NOT TESTED (--no-browser)");
} else {
  const probe = run("npx", ["playwright", "--version"]);
  if (probe.status !== 0) {
    record("Browser matrix (Chromium/Firefox/WebKit)", "NOT TESTED", "playwright unavailable");
    console.log("→ Browser matrix ... NOT TESTED (playwright unavailable)");
  } else {
    gate("Browser matrix (Chromium/Firefox/WebKit)", "npx", ["playwright", "test", "--reporter=line"], {
      extract: (out) => {
        const m = stripAnsi(out).match(/(\d+)\s+passed/);
        return m ? `${m[1]} runs` : "";
      },
    });
  }
}

// --- soak -------------------------------------------------------------------
if (SKIP_SOAK) {
  record("Lifecycle + SSR soak", "NOT TESTED", "skipped via --no-soak");
  console.log("→ Soak ... NOT TESTED (--no-soak)");
} else {
  gate("Lifecycle + SSR soak", "npx", ["vitest", "run", "-c", "vitest.soak.config.ts", "--reporter=dot"], {
    extract: countTests,
  });
}

// --- package + bundler ------------------------------------------------------
if (SKIP_PACKAGE) {
  record("Packed package + subpath exports", "NOT TESTED", "skipped via --no-package");
  record("Bundler matrix (Vite/Rollup/esbuild/Webpack)", "NOT TESTED", "skipped via --no-package");
  console.log("→ Package/bundler ... NOT TESTED (--no-package)");
} else {
  const work = mkdtempSync(join(tmpdir(), "sibujs-rc-"));

  process.stdout.write("→ npm pack ... ");
  const packed = run("npm", ["pack", "--pack-destination", work]);
  if (packed.status !== 0) {
    record("Packed package + subpath exports", "FAIL", "npm pack failed");
    record("Bundler matrix (Vite/Rollup/esbuild/Webpack)", "NOT TESTED", "no tarball");
    console.log("FAIL");
  } else {
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    const tarball = join(work, tgz);
    console.log(`PASS (${tgz})`);

    // Consumer project that installs ONLY the tarball — never a workspace link.
    const consumer = join(work, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "rc-consumer", version: "1.0.0", type: "module", private: true }, null, 2),
    );

    process.stdout.write("→ install packed tarball ... ");
    const install = run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: consumer });
    if (install.status !== 0) {
      record("Packed package + subpath exports", "FAIL", "install failed");
      record("Bundler matrix (Vite/Rollup/esbuild/Webpack)", "NOT TESTED", "install failed");
      console.log("FAIL");
    } else {
      console.log("PASS");
      gate("Packed package + subpath exports", "node", [join(HERE, "exports-audit.mjs")], {
        opts: { cwd: consumer },
        extract: (out) => {
          const m = stripAnsi(out).match(/(\d+)\/(\d+) checks passed across (\d+) subpaths/);
          return m ? `${m[1]}/${m[2]} checks, ${m[3]} subpaths` : "";
        },
      });

      gate(
        "Bundler matrix (Vite/Rollup/esbuild/Webpack)",
        "node",
        [join(HERE, "bundler-matrix.mjs"), join(work, "bundlers"), tarball],
        {
          extract: (out) => {
            out = stripAnsi(out);
            const b = out.match(/builds:\s+(\d+\/\d+)/);
            const r = out.match(/runtime:\s+(\d+\/\d+)/);
            const s = out.match(/tree-shaking:\s+(\d+\/\d+)/);
            return [b && `builds ${b[1]}`, r && `runtime ${r[1]}`, s && `shake ${s[1]}`]
              .filter(Boolean)
              .join(", ");
          },
        },
      );
    }
  }
}

// --- Node support matrix ----------------------------------------------------
// Every Node line `engines.node` claims, exercised against the packed tarball.
// `engines` is a promise; before this gate existed it claimed ">=18" while CI
// ran Node 20 only, and two P1s were hiding on the versions nobody executed.
{
  process.stdout.write("→ Node support matrix ... ");
  const r = run("node", [join(HERE, "node-matrix.mjs")]);
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  const versions = [...out.matchAll(/^Node (\S+) .*— (PASS|FAIL|INCOMPLETE)$/gm)].map(
    (m) => `${m[1]}:${m[2]}`,
  );
  const incomplete = out.includes("INCOMPLETE");
  const status = r.status === 0 ? (incomplete ? "NOT TESTED" : "PASS") : "FAIL";
  record("Node support matrix", status, versions.join(" "), true);
  console.log(`${status} ${versions.join(" ")}`);
  if (status !== "PASS") {
    console.log(out.trim().split(String.fromCharCode(10)).slice(-60).join(String.fromCharCode(10)).replace(/^/gm, "    | "));
  }
}

// --- report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${"=".repeat(96)}\nCERTIFICATION GATES\n${"=".repeat(96)}`);
for (const r of results) {
  console.log(
    `${pad(r.status, 14)}${pad(r.gate, 46)}${r.detail}${r.required ? "" : "   [non-blocking]"}`,
  );
}

const failed = results.filter((r) => r.status === "FAIL" && r.required);
const notTested = results.filter((r) => r.status === "NOT TESTED");
const passed = results.filter((r) => r.status === "PASS");

console.log(`${"=".repeat(96)}`);
console.log(`PASS: ${passed.length}   FAIL: ${failed.length}   NOT TESTED: ${notTested.length}`);
if (notTested.length) {
  console.log("\nNOT TESTED is NOT a pass. Unverified gates:");
  for (const r of notTested) console.log(`  - ${r.gate}: ${r.detail}`);
}
console.log(failed.length ? "\nRESULT: CERTIFICATION FAILED" : "\nRESULT: ALL REQUIRED GATES PASSED");
process.exit(failed.length ? 1 : 0);
