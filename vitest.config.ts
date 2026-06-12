/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
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
