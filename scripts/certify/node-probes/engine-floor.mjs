// Evidence for the declared engine floor.
//
// `package.json` says `engines.node: ">=22.3.0"`. That number is not arbitrary:
// SSR request isolation needs `AsyncLocalStorage`, and under ESM the only
// synchronous way to load a builtin is `process.getBuiltinModule`, added in
// Node 22.3.0. Below it the ESM build cannot obtain ALS at all and concurrent
// requests share one store.
//
// This probe reports the CAPABILITY and the OBSERVED BEHAVIOUR side by side, so
// running it on a pre-floor build documents *why* that build is excluded rather
// than simply failing. It is deliberately capability-driven — nothing in the
// framework branches on a version string, and nothing here should either.
//
// Run on any Node build:
//   node scripts/certify/node-probes/engine-floor.mjs
import { runInSSRContext, getRequestScopedCache } from "sibujs";

const version = process.versions.node;
const hasGetBuiltinModule = typeof process.getBuiltinModule === "function";

// The pre-22.3 fallback this code used to rely on. Recorded to show it is not a
// viable substitute: `Function(...)` evaluates in GLOBAL scope, where `require`
// exists in neither module system.
const globalScopeRequire = Function("return typeof require === 'function' ? require : null")();

// Interleave two requests: A starts, B starts, B completes, A resumes.
// Constructing an AsyncLocalStorage proves nothing; only interleaving does.
const order = [];
const [a, b] = await Promise.all([
  runInSSRContext(async () => {
    order.push("A:start");
    const before = getRequestScopedCache("query");
    await new Promise((r) => setTimeout(r, 30)); // A resumes LAST
    order.push("A:resume");
    return { tag: "A", before, after: getRequestScopedCache("query") };
  }),
  runInSSRContext(async () => {
    order.push("B:start");
    const before = getRequestScopedCache("query");
    await new Promise((r) => setTimeout(r, 5)); // B completes FIRST
    order.push("B:done");
    return { tag: "B", before, after: getRequestScopedCache("query") };
  }),
]);

const available = a.after !== null && b.after !== null;
const distinct = available && a.after !== b.after;
const stable = a.before === a.after && b.before === b.after;
const isolated = available && distinct && stable;

// The interleaving must actually have happened, or "isolated" proves nothing.
const interleaved = order.join(" ") === "A:start B:start B:done A:resume";

console.log(`node                     ${version}`);
console.log(`process.getBuiltinModule ${hasGetBuiltinModule ? "function" : "undefined"}`);
console.log(`global-scope require     ${globalScopeRequire ? "available" : "null (never a usable fallback)"}`);
console.log(`interleave order         ${order.join(" ")}`);
console.log(`ALS available            ${available}`);
console.log(`scopes distinct          ${distinct}`);
console.log(`scope stable across await ${stable}`);
console.log(
  `ENGINE_FLOOR_PROBE ${isolated && interleaved ? "SUPPORTED" : "UNSUPPORTED"} ` +
    `node=${version} getBuiltinModule=${hasGetBuiltinModule} isolated=${isolated} interleaved=${interleaved}`,
);

// Capability and behaviour must agree. If they ever diverge, the floor's
// stated rationale is wrong and this exits non-zero to say so.
if (hasGetBuiltinModule !== isolated) {
  console.log(
    "ENGINE_FLOOR_PROBE MISMATCH: getBuiltinModule availability does not predict " +
      "isolation on this runtime — the documented rationale for the floor needs revisiting.",
  );
  process.exit(2);
}
process.exit(isolated && interleaved ? 0 : 1);
