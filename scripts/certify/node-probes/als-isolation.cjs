// SSR request-isolation probe, CommonJS form.
//
// Separate from the ESM probe on purpose: the AsyncLocalStorage detection in
// `src/core/ssr-context.ts` has two branches — `process.getBuiltinModule`
// (Node 22.3+) and a `require`-based fallback for everything older — and only
// a CJS entry point can exercise the second one. (NODE-002)
const { runInSSRContext, getRequestScopedCache } = require("sibujs");

Promise.all(
  ["A", "B"].map((tag) =>
    runInSSRContext(async () => {
      const before = getRequestScopedCache("query");
      await new Promise((r) => setTimeout(r, 5));
      const after = getRequestScopedCache("query");
      return { tag, before, after, stable: before === after };
    }),
  ),
).then(([a, b]) => {
  const available = a.after !== null && b.after !== null;
  const distinct = available && a.after !== b.after;
  const ok = distinct && a.stable && b.stable;
  console.log(
    `ALS_CJS_PROBE ${ok ? "PASS" : "FAIL"} available=${available} distinct=${distinct} stable=${a.stable && b.stable}`,
  );
  process.exit(ok ? 0 : 1);
});
