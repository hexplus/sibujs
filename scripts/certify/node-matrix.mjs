// ---------------------------------------------------------------------------
// Node.js support-matrix certification.
//
//   node scripts/certify/node-matrix.mjs [--versions=22,24]
//
// `package.json` declares `engines.node: ">=22.3.0"`. That claim is only worth
// anything if CI has actually executed on every line it covers, so this runs the
// full compatibility gate on each — including against the PACKED tarball,
// because package-export resolution and emitted syntax can behave differently
// from repository execution.
//
// Per-version gates (§57). Every one is reported individually; a version with
// any gate unrun is reported INCOMPLETE, never summarised as PASS.
//
//   install · build · source typecheck · test typecheck · unit suite ·
//   npm pack · ESM import · CJS require · DOM-less router (RC-001) ·
//   query clean exit (RC-002) · SSR request context · runtime compat (RC-003)
//
// Node binaries are invoked directly from their install directories rather than
// by switching a global version-manager symlink: switching mutates machine state
// and races anything else running on the host.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PROBES = join(HERE, "node-probes");

const argv = process.argv.slice(2);
const versionArg = argv.find((a) => a.startsWith("--versions="))?.split("=")[1];

// Two kinds of target, and the difference matters for the support claim:
//
//   "22"      -> the newest 22.x available: proves the current release LINE works
//   "22.3.0"  -> that exact build: proves the DECLARED MINIMUM works
//
// `engines.node` is ">=22.3.0", and testing "22 latest" does not verify 22.3.0 —
// a floor nobody has executed is exactly the gap this tooling exists to close.
// The default therefore pins the exact floor alongside the two current lines.
const WANT = (versionArg ?? "22.3.0,22,24").split(",").map((s) => s.trim());

// Extra interpreter roots, e.g. hand-extracted official builds for a version no
// local version manager has. Colon/semicolon separated, matching PATH.
const EXTRA_ROOTS = (process.env.SIBUJS_NODE_ROOTS ?? "")
  .split(process.platform === "win32" ? ";" : ":")
  .map((r) => r.trim())
  .filter(Boolean);

const ALL_GATES = [
  "install",
  "build",
  "source typecheck",
  "test typecheck",
  "unit suite",
  "npm pack",
  "ESM import",
  "CJS require",
  "DOM-less router construct (RC-001)",
  "DOM-less memory-router navigate (NODE-001)",
  "query clean exit (RC-002)",
  "SSR request context",
  "SSR isolation (CJS)",
  "SSR streaming smoke",
  "runtime compat (RC-003)",
];

// ---------------------------------------------------------------------------
// Interpreter discovery
// ---------------------------------------------------------------------------
/** Pull a semver-ish version out of a directory name, e.g. `node-v22.3.0-win-x64`. */
function versionOf(entry) {
  const m = entry.match(/v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Locate an interpreter for `target`, which is either a major line ("22") or an
 * exact version ("22.3.0").
 *
 * Version managers keep versioned install roots (`v22.14.0/`); hand-extracted
 * official archives keep `node-v22.3.0-win-x64/`. Both shapes are matched, and
 * `SIBUJS_NODE_ROOTS` adds arbitrary extra roots so an exact floor can be tested
 * without a version manager or elevated install rights.
 *
 * Falls back to the running interpreter when it satisfies the target, so this
 * still works on a CI runner where actions/setup-node provided exactly one.
 */
function discover(target) {
  const exact = /^\d+\.\d+\.\d+$/.test(target);
  const major = target.split(".")[0];
  const candidates = [];

  const roots = [
    ...EXTRA_ROOTS,
    process.env.NVM_HOME,
    process.env.NVM_DIR && join(process.env.NVM_DIR, "versions", "node"),
    process.env.APPDATA && join(process.env.APPDATA, "nvm"),
    process.env.HOME && join(process.env.HOME, ".nvm", "versions", "node"),
  ].filter(Boolean);

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const version = versionOf(entry);
      if (!version) continue;
      if (exact ? version !== target : version.split(".")[0] !== major) continue;
      for (const rel of ["node.exe", "node", join("bin", "node")]) {
        const bin = join(root, entry, rel);
        if (existsSync(bin)) candidates.push({ bin, label: `v${version}` });
      }
    }
  }

  if (candidates.length) {
    // Highest patch wins for a line target; for an exact target they are equal.
    candidates.sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
    return candidates[0];
  }

  const running = process.versions.node;
  const satisfies = exact ? running === target : running.split(".")[0] === major;
  if (satisfies) return { bin: process.execPath, label: `v${running}` };
  return null;
}

// npm ships beside the interpreter; use THAT npm, never the ambient one, or the
// matrix silently tests one npm against four Node versions (§43).
function npmFor(nodeBin) {
  const dir = dirname(nodeBin);
  for (const rel of ["npm.cmd", "npm", join("bin", "npm")]) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    ...opts,
  });

// Vitest/biome colourise output, so digits are separated from labels by escape
// sequences. Built from the code point to keep a raw control byte out of source.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s) => String(s).replace(ANSI, "");

// ---------------------------------------------------------------------------
const report = [];

for (const target of WANT) {
  const found = discover(target);
  const gates = [];
  const add = (name, status, detail = "") => gates.push({ name, status, detail });

  if (!found) {
    console.log(`\n=== Node ${target}: interpreter NOT FOUND — every gate NOT TESTED ===`);
    for (const g of ALL_GATES) add(g, "NOT TESTED", "no interpreter available");
    report.push({ target, label: null, npm: null, gates });
    continue;
  }

  const NODE = found.bin;
  const NPM = npmFor(NODE);
  const npmVersion = NPM ? run(NPM, ["-v"]).stdout?.trim() : "(bundled npm not found)";
  console.log(`\n=== Node ${target} (${found.label}, npm ${npmVersion}) ===`);

  const work = mkdtempSync(join(tmpdir(), `sibujs-node${target.replace(/\./g, "_")}-`));
  const nodeDir = dirname(NODE);
  // Put this interpreter first on PATH so any tool that shells out to `node`
  // (tsup, vitest workers) uses the version under test, not the ambient one.
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${nodeDir}${sep}${process.env.PATH}` };
  const inRepo = { cwd: REPO, env };

  const gate = (name, cmd, args, opts = {}, extract) => {
    process.stdout.write(`  ${name} ... `);
    const r = run(cmd, args, { ...inRepo, ...opts });
    const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    const ok = r.status === 0;
    const detail = extract ? extract(out) : "";
    add(name, ok ? "PASS" : "FAIL", detail);
    gates[gates.length - 1].raw = out;
    console.log(ok ? `PASS ${detail}` : `FAIL ${detail}`);
    if (!ok) console.log(out.trim().split("\n").slice(-10).join("\n").replace(/^/gm, "      | "));
    return ok;
  };

  // --- repository gates ----------------------------------------------------
  gate("install", NPM, ["install", "--no-audit", "--no-fund"]);
  gate("build", NPM, ["run", "build"]);
  gate("source typecheck", NODE, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  gate("test typecheck", NODE, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"], {}, (out) => {
    const n = out.split("\n").filter((l) => /error TS/.test(l)).length;
    return n ? `${n} errors` : "0 errors";
  });
  gate("unit suite", NODE, ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot"], {}, (out) => {
    const m = out.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/);
    return m ? `${m[1]} tests${m[2] ? ` (+${m[2]} skipped)` : ""}` : "";
  });

  // --- packed-package gates ------------------------------------------------
  let consumer = null;
  const packed = run(NPM, ["pack", "--pack-destination", work], inRepo);
  if (packed.status !== 0) {
    add("npm pack", "FAIL", "");
    console.log("  npm pack ... FAIL");
  } else {
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    add("npm pack", "PASS", tgz);
    console.log(`  npm pack ... PASS ${tgz}`);

    consumer = join(work, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: `n${target.replace(/\./g, "-")}-consumer`, version: "1.0.0", type: "module", private: true }, null, 2),
    );
    // jsdom is required because SSR rendering takes real DOM nodes. Pin it to
    // the version this repository itself develops against, rather than letting
    // the probe float to `jsdom@latest`: a floating install resolved a
    // transitive `html-encoding-sniffer` that `require()`s an ES module, which
    // needs Node >= 22.12, and the probe then failed on Node 22.3.0 — reporting
    // the framework as broken at its own declared floor when the incompatibility
    // was entirely in the test harness's DOM. A tooling dependency must never
    // dictate the published runtime floor.
    const jsdomSpec = `jsdom@${JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies.jsdom}`;
    const inst = run(NPM, ["install", join(work, tgz), jsdomSpec, "--no-audit", "--no-fund"], {
      cwd: consumer,
      env,
    });
    if (inst.status !== 0) {
      console.log(`  consumer install ... FAIL`);
      console.log(stripAnsi(`${inst.stderr}`).trim().split("\n").slice(-6).join("\n").replace(/^/gm, "      | "));
      consumer = null;
    }
  }

  if (!consumer) {
    for (const g of [
      "ESM import",
      "CJS require",
      "DOM-less router construct (RC-001)",
      "DOM-less memory-router navigate (NODE-001)",
      "query clean exit (RC-002)",
      "SSR request context",
      "SSR isolation (CJS)",
      "SSR streaming smoke",
      "runtime compat (RC-003)",
    ])
      add(g, "NOT TESTED", "no consumer project");
  } else {
    const inConsumer = { cwd: consumer, env };

    // Enumerate the package's own export map rather than hard-coding subpaths,
    // so a newly added entry cannot silently escape the matrix (§11).
    const pkgPath = join(consumer, "node_modules", "sibujs", "package.json");
    const subpaths = Object.keys(JSON.parse(readFileSync(pkgPath, "utf8")).exports ?? {});
    const importable = subpaths.filter((s) => s !== "./cdn" && s !== "./package.json");
    const specs = importable.map((s) => (s === "." ? "sibujs" : `sibujs${s.slice(1)}`));

    writeFileSync(
      join(consumer, "esm-import.mjs"),
      [
        `const specs = ${JSON.stringify(specs)};`,
        "let bad = 0;",
        "const timers = [];",
        'for (const n of ["setTimeout", "setInterval"]) {',
        "  const orig = globalThis[n];",
        "  globalThis[n] = (...a) => { timers.push(n); return orig(...a); };",
        "}",
        "for (const s of specs) {",
        "  try {",
        "    const m = await import(s);",
        '    if (Object.keys(m).filter((k) => k !== "default").length === 0) { bad++; console.log("FAIL empty", s); }',
        '  } catch (e) { bad++; console.log("FAIL", s, e.code || e.name, e.message.split("\\n")[0]); }',
        "}",
        'if (timers.length) { bad++; console.log("FAIL import-time timers:", timers.join(",")); }',
        'console.log(bad ? "ESM_IMPORT: FAIL" : `ESM_IMPORT: PASS (${specs.length} subpaths)`);',
        "process.exit(bad ? 1 : 0);",
      ].join("\n"),
    );
    gate("ESM import", NODE, ["esm-import.mjs"], inConsumer, (o) => o.match(/PASS \(([^)]+)\)/)?.[1] ?? "");

    writeFileSync(
      join(consumer, "cjs-require.cjs"),
      [
        `const specs = ${JSON.stringify(specs)};`,
        "let bad = 0;",
        "for (const s of specs) {",
        "  try {",
        "    const m = require(s);",
        '    if (Object.keys(m).length === 0) { bad++; console.log("FAIL empty", s); }',
        '  } catch (e) { bad++; console.log("FAIL", s, e.code || e.name, String(e.message).split("\\n")[0]); }',
        "}",
        'console.log(bad ? "CJS_REQUIRE: FAIL" : `CJS_REQUIRE: PASS (${specs.length} subpaths)`);',
        "process.exit(bad ? 1 : 0);",
      ].join("\n"),
    );
    gate("CJS require", NODE, ["cjs-require.cjs"], inConsumer, (o) => o.match(/PASS \(([^)]+)\)/)?.[1] ?? "");

    // The ESM and CJS entry points exercise DIFFERENT AsyncLocalStorage
    // detection branches (`process.getBuiltinModule` vs a lexical `require`),
    // so isolation has to be proved separately in each format — NODE-002 was
    // invisible in one of them.
    for (const [name, file] of [
      ["DOM-less router construct (RC-001)", "domless-router.mjs"],
      ["SSR isolation (CJS)", "als-isolation.cjs"],
      ["runtime compat (RC-003)", "runtime-compat.mjs"],
    ]) {
      writeFileSync(join(consumer, file), readFileSync(join(PROBES, file), "utf8"));
      gate(name, NODE, [file], inConsumer, (o) => o.match(/(\d+\/\d+ checks passed)/)?.[1] ?? "");
    }

    // RC-002 is special: the assertion is that the process exits BY ITSELF.
    // It must not be killed, and a timeout is a failure, not a flaky probe.
    {
      process.stdout.write("  query clean exit (RC-002) ... ");
      writeFileSync(join(consumer, "clean-exit.mjs"), readFileSync(join(PROBES, "clean-exit.mjs"), "utf8"));
      const started = Date.now();
      const r = run(NODE, ["clean-exit.mjs"], { ...inConsumer, timeout: 20_000 });
      const elapsed = Date.now() - started;
      const timedOut = r.error?.code === "ETIMEDOUT" || r.signal != null || r.killed;
      const ran = /CLEAN_EXIT_PROBE/.test(stripAnsi(r.stdout ?? ""));
      const ok = !timedOut && r.status === 0 && ran;
      add(
        "query clean exit (RC-002)",
        ok ? "PASS" : "FAIL",
        timedOut ? "event loop pinned (>20s)" : `exited in ${elapsed}ms`,
      );
      console.log(ok ? `PASS exited in ${elapsed}ms` : `FAIL ${timedOut ? "event loop pinned" : `status ${r.status}`}`);
    }

    // Several gates are asserted INSIDE a probe. Surface each as its own row so
    // a partially-run version can never be summarised as PASS (§2), and derive
    // the status from the probe's own per-check output rather than from the
    // process exit code alone.
    const rc = gates.find((g) => g.name === "runtime compat (RC-003)");
    const rcOut = rc?.raw ?? "";
    const checkStatus = (needle) => {
      if (!rcOut) return rc?.status ?? "NOT TESTED";
      if (rcOut.includes(`FAIL ${needle}`)) return "FAIL";
      if (rcOut.includes(`ok   ${needle}`)) return "PASS";
      return "NOT TESTED";
    };
    add("SSR request context", checkStatus("SSR request isolation"), "asserted by the runtime-compat probe");
    add(
      "SSR streaming smoke",
      checkStatus("renderToStream + collectStream") === "PASS" && checkStatus("renderToReadableStream") === "PASS"
        ? "PASS"
        : "FAIL",
      "renderToStream + renderToReadableStream",
    );

    // Memory-router navigation is asserted by the DOM-less probe (NODE-001).
    const dr = gates.find((g) => g.name === "DOM-less router construct (RC-001)");
    const drOut = dr?.raw ?? "";
    add(
      "DOM-less memory-router navigate (NODE-001)",
      drOut.includes("navigate=true") && drOut.includes("replace=true")
        ? "PASS"
        : drOut
          ? "FAIL"
          : (dr?.status ?? "NOT TESTED"),
      drOut.match(/navigate=\w+ replace=\w+/)?.[0] ?? "",
    );
  }

  report.push({ target, label: found.label, npm: npmVersion, gates });
}

// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${"=".repeat(100)}\nNODE SUPPORT MATRIX\n${"=".repeat(100)}`);
for (const v of report) {
  const fails = v.gates.filter((g) => g.status === "FAIL");
  const untested = v.gates.filter((g) => g.status === "NOT TESTED");
  const verdict = fails.length ? "FAIL" : untested.length ? "INCOMPLETE" : "PASS";
  console.log(`\nNode ${v.target} ${v.label ? `(${v.label}, npm ${v.npm})` : "(not installed)"} — ${verdict}`);
  for (const g of v.gates) console.log(`  ${pad(g.status, 12)}${pad(g.name, 44)}${g.detail}`);
}

const anyFail = report.some((v) => v.gates.some((g) => g.status === "FAIL"));
const anyUntested = report.some((v) => v.gates.some((g) => g.status === "NOT TESTED"));
console.log(`\n${"=".repeat(100)}`);
console.log(anyFail ? "RESULT: FAIL" : anyUntested ? "RESULT: INCOMPLETE (unverified gates remain)" : "RESULT: PASS");
// Drop the captured probe output before serialising — it is only needed to
// derive the individual gate rows above, and would bloat the report by megabytes.
const serialisable = report.map((v) => ({
  ...v,
  gates: v.gates.map(({ raw: _raw, ...g }) => g),
}));
writeFileSync(join(REPO, "docs/hardening/node-matrix-report.json"), JSON.stringify(serialisable, null, 2));
process.exit(anyFail ? 1 : 0);
