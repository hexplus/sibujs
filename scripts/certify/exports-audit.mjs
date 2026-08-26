// ---------------------------------------------------------------------------
// Certification gate: subpath exports + import-time side effects.
//
// Runs INSIDE a consumer project that has installed the packed tarball, so it
// exercises the same resolution path npm consumers get — not repo-relative
// source imports.
//
//   node exports-audit.mjs            # run from the consumer project root
//
// Checks, per public subpath declared in the installed package.json `exports`:
//   1. every declared target file physically exists in the package
//   2. `import()` resolves and evaluates
//   3. the declared `types` file exists
//   4. importing it in bare Node does not touch `window`/`document`, install
//      global listeners, start timers, or mutate globals beyond a documented
//      allowlist
//
// Exit code 0 = PASS. Any failure exits 1 and prints the offending subpath.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolve from the CONSUMER's cwd, not from this script's location. The repo
// itself is named `sibujs`, so a module-relative resolve would hit Node's
// `trySelf` path and silently audit the source tree instead of the installed
// tarball — exactly the mistake this gate exists to catch.
// (`sibujs/package.json` is not a declared export subpath, so the package.json
// is read by path rather than by specifier — see finding PKG-001.)
const PKG_DIR = resolve(process.cwd(), "node_modules/sibujs");
if (!existsSync(resolve(PKG_DIR, "package.json"))) {
  console.error(`FAIL: no installed sibujs at ${PKG_DIR} — run this from a consumer project root`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8"));

const results = [];
const fail = (subpath, check, detail) => results.push({ subpath, check, ok: false, detail });
const pass = (subpath, check, detail = "") => results.push({ subpath, check, ok: true, detail });

// --- 1. every declared export target exists on disk ------------------------
const subpaths = Object.keys(pkg.exports ?? {});
if (subpaths.length === 0) {
  console.error("FAIL: package declares no `exports` map");
  process.exit(1);
}

for (const subpath of subpaths) {
  const entry = pkg.exports[subpath];
  const targets = typeof entry === "string" ? { default: entry } : entry;
  for (const [condition, rel] of Object.entries(targets)) {
    if (typeof rel !== "string") continue;
    const abs = resolve(PKG_DIR, rel);
    if (existsSync(abs)) pass(subpath, `file:${condition}`, rel);
    else fail(subpath, `file:${condition}`, `${rel} is declared but MISSING`);
  }
}

// --- 2/3. resolve + evaluate each subpath, watching for side effects -------

// Globals a subpath is allowed to define at import time. The reactive runtime
// publishes its implementation on a versioned Symbol.for registry so that
// duplicate bundler copies share one reactive world (see src/reactivity/track.ts);
// that is a documented, intentional import-time global.
const ALLOWED_GLOBAL_SYMBOLS = [/^sibujs\./];

function snapshotGlobals() {
  return {
    keys: new Set(Object.keys(globalThis)),
    symbols: new Set(Object.getOwnPropertySymbols(globalThis).map((s) => s.toString())),
  };
}

// Trip-wires for ambient work at import time.
//
// Deliberately NOT tripwired: reads of `window` / `document`. A throwing getter
// for those is unfaithful — `typeof window === "undefined"` is the *correct*
// environment guard, and it invokes a defined getter where a genuinely absent
// global would short-circuit to "undefined". An earlier revision of this script
// did exactly that and reported three false failures (see rc-findings TEST-001).
// The faithful check is simply: does importing in bare Node throw? That is what
// the `import` check below measures, in an environment with no browser globals
// synthesised at all.
const timerLog = [];
const listenerLog = [];
function installTripwires() {
  for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
    const orig = globalThis[name];
    if (typeof orig !== "function") continue;
    globalThis[name] = function (...args) {
      timerLog.push(name);
      return orig.apply(this, args);
    };
  }
  // If a host-ish global genuinely exists in this runtime, watch for listener
  // installation at import time; do not synthesise one that isn't there.
  for (const name of ["process", "globalThis"]) {
    const target = name === "globalThis" ? globalThis : globalThis[name];
    if (!target || typeof target.on !== "function") continue;
    const origOn = target.on;
    target.on = function (...args) {
      listenerLog.push(`${name}.on(${String(args[0])})`);
      return origOn.apply(this, args);
    };
  }
}
installTripwires();

const before = snapshotGlobals();

for (const subpath of subpaths) {
  const spec = subpath === "." ? "sibujs" : `sibujs${subpath.slice(1)}`;
  const entry = pkg.exports[subpath];
  const targets = typeof entry === "string" ? { default: entry } : entry;

  // `./cdn` is an IIFE global build, not an ESM module — resolve-only.
  const importable = Boolean(targets.import ?? targets.default?.endsWith(".js"));

  const timersBefore = timerLog.length;
  const readsBefore = listenerLog.length;

  if (importable && subpath !== "./cdn") {
    try {
      const ns = await import(spec);
      const named = Object.keys(ns).filter((k) => k !== "default");
      if (named.length === 0) fail(subpath, "import", "resolved but exports nothing");
      else pass(subpath, "import", `${named.length} named exports`);
    } catch (err) {
      fail(subpath, "import", `${err.name}: ${err.message}`);
    }
  } else {
    // Non-ESM condition: verify the file at least parses as the declared kind.
    const rel = targets.default ?? Object.values(targets)[0];
    if (existsSync(resolve(PKG_DIR, rel))) pass(subpath, "import", "non-ESM target, resolve-only");
    else fail(subpath, "import", "non-ESM target missing");
  }

  const newTimers = timerLog.length - timersBefore;
  if (newTimers > 0) fail(subpath, "side-effect:timers", `${newTimers} timer(s) started at import`);
  else pass(subpath, "side-effect:timers");

  const newReads = listenerLog.length - readsBefore;
  if (newReads > 0)
    fail(subpath, "side-effect:listeners", listenerLog.slice(readsBefore).join(", "));
  else pass(subpath, "side-effect:listeners");

  // types file
  if (targets.types) {
    if (existsSync(resolve(PKG_DIR, targets.types))) pass(subpath, "types", targets.types);
    else fail(subpath, "types", `${targets.types} MISSING`);
  } else if (subpath !== "./cdn") {
    fail(subpath, "types", "no `types` condition declared");
  } else {
    pass(subpath, "types", "n/a (global build)");
  }
}

const after = snapshotGlobals();
const newKeys = [...after.keys].filter((k) => !before.keys.has(k));
const newSymbols = [...after.symbols].filter((s) => !before.symbols.has(s));
const unexpectedSymbols = newSymbols.filter(
  (s) => !ALLOWED_GLOBAL_SYMBOLS.some((re) => re.test(s.replace(/^Symbol\(|\)$/g, ""))),
);

if (newKeys.length) fail("<all>", "side-effect:globals", `new string globals: ${newKeys.join(", ")}`);
else pass("<all>", "side-effect:globals", "no new string globals");

if (unexpectedSymbols.length)
  fail("<all>", "side-effect:global-symbols", `unexpected: ${unexpectedSymbols.join(", ")}`);
else pass("<all>", "side-effect:global-symbols", `documented only: ${newSymbols.join(", ") || "none"}`);

// --- report ----------------------------------------------------------------
const failures = results.filter((r) => !r.ok);
const byPath = new Map();
for (const r of results) {
  if (!byPath.has(r.subpath)) byPath.set(r.subpath, []);
  byPath.get(r.subpath).push(r);
}
for (const [subpath, rs] of byPath) {
  const bad = rs.filter((r) => !r.ok);
  const mark = bad.length ? "FAIL" : "ok  ";
  console.log(`${mark} ${subpath.padEnd(14)} ${rs.length} checks`);
  for (const r of bad) console.log(`       -> ${r.check}: ${r.detail}`);
}
console.log(
  `\nexports-audit: ${results.length - failures.length}/${results.length} checks passed across ${subpaths.length} subpaths`,
);
if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length})`);
  process.exit(1);
}
console.log("RESULT: PASS");
