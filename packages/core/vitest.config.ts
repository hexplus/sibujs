/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    // A few large-list/deep-tree stress tests legitimately run ~8s each; under
    // full-suite worker contention on a loaded CI runner they can stretch well
    // past Vitest's 5s default and flake. 30s clears the real runtime with ample
    // headroom without masking genuine hangs (a stuck reconciliation never ends).
    testTimeout: 30000,
  },
});
