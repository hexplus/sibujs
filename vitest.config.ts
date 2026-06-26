/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    // Scope vitest to the jsdom unit tests. Real-browser Playwright specs live
    // in `tests-browser/` (run via `npm run test:browser`) and must not be
    // picked up here — they use @playwright/test's incompatible `test`/`expect`.
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      // Exclude build artifacts, dependencies, test files, and non-source
      // tooling scripts (benchmarks, publish/release helpers, config). These
      // are not application source and should not count toward coverage.
      exclude: [
        "dist",
        "node_modules",
        "tests/**",
        "**/*.test.ts",
        "**/*.config.ts",
        "bench.mjs",
        "publish.mjs",
        // Type-only modules (interfaces/type aliases, zero runtime to execute).
        "src/reactivity/signal.ts",
        "src/core/rendering/types.ts",
        "src/core/rendering/tagPropTypes.ts",
      ],
    },
  },
});
