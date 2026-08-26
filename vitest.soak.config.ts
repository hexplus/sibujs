/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

// Long-running lifecycle soak, kept OUT of the fast PR suite.
//
// `vitest.config.ts` includes only `tests/**/*.test.ts`, so the `.soak.ts`
// files here are invisible to `npm test` by design — nobody should wait on a
// minutes-long soak for every commit. Run it explicitly:
//
//   npm run test:soak              # counters only
//   npm run test:soak:gc           # adds --expose-gc heap corroboration
//
// Measured runtime: ~4 s on a 12th-gen i7. Intended for release candidates and
// scheduled CI rather than pull requests — the iteration counts are meant to
// grow, and the counter baselines it asserts are global state that must not be
// interleaved with the parallel PR suite.
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/soak/**/*.soak.ts"],
    // Soak assertions run tens of thousands of iterations; the default 5 s
    // per-test timeout is far too tight and would report load as failure.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Sequential: these measure global counters (active bindings, cache
    // entries, router state). Parallel workers would interleave and make the
    // baselines meaningless.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
