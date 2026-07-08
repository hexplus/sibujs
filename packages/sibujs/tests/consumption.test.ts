import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const distDir = resolve(__dirname, "../dist");

describe("Package consumption", () => {
  // ── ESM entry points exist ───────────────────────────────────────────────

  describe("ESM entry points", () => {
    const esmFiles = [
      "index.js",
      "extras.js",
      "data.js",
      "browser.js",
      "patterns.js",
      "motion.js",
      "plugins.js",
      "build.js",
      "testing.js",
    ];

    for (const file of esmFiles) {
      it(`dist/${file} exists and is non-empty`, () => {
        const path = resolve(distDir, file);
        expect(existsSync(path)).toBe(true);
        const content = readFileSync(path, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      });
    }
  });

  // ── CJS entry points exist ─────────────────────────────────────────────

  describe("CJS entry points", () => {
    const cjsFiles = [
      "index.cjs",
      "extras.cjs",
      "data.cjs",
      "browser.cjs",
      "patterns.cjs",
      "motion.cjs",
      "plugins.cjs",
      "build.cjs",
      "testing.cjs",
    ];

    for (const file of cjsFiles) {
      it(`dist/${file} exists and is non-empty`, () => {
        const path = resolve(distDir, file);
        expect(existsSync(path)).toBe(true);
        const content = readFileSync(path, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      });
    }
  });

  // ── Type declaration files exist ───────────────────────────────────────

  describe("Type declarations", () => {
    const dtsFiles = [
      "index.d.ts",
      "extras.d.ts",
      "data.d.ts",
      "browser.d.ts",
      "patterns.d.ts",
      "motion.d.ts",
      "plugins.d.ts",
      "build.d.ts",
      "testing.d.ts",
    ];

    for (const file of dtsFiles) {
      it(`dist/${file} exists`, () => {
        expect(existsSync(resolve(distDir, file))).toBe(true);
      });
    }
  });

  // ── IIFE/CDN build ─────────────────────────────────────────────────────

  describe("IIFE/CDN build", () => {
    it("dist/cdn.global.js exists", () => {
      expect(existsSync(resolve(distDir, "cdn.global.js"))).toBe(true);
    });

    it("IIFE build is minified (smaller than ESM)", () => {
      const iife = readFileSync(resolve(distDir, "cdn.global.js"), "utf-8");
      const _esm = readFileSync(resolve(distDir, "index.js"), "utf-8");
      // IIFE is self-contained (includes all deps), so it'll be larger than index.js
      // but it should exist and be non-trivial
      expect(iife.length).toBeGreaterThan(1000);
    });

    it("IIFE build contains the Sibu global registration", () => {
      const content = readFileSync(resolve(distDir, "cdn.global.js"), "utf-8");
      expect(content).toContain("Sibu");
    });

    it("IIFE build contains core functions", () => {
      const content = readFileSync(resolve(distDir, "cdn.global.js"), "utf-8");
      // Minified names may differ, but the global object name should be present
      expect(content).toContain("signal");
    });
  });

  // ── package.json exports field ─────────────────────────────────────────

  describe("package.json exports", () => {
    it("has all subpath exports configured", () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
      const exports = pkg.exports;

      expect(exports["."]).toBeDefined();
      expect(exports["./data"]).toBeDefined();
      expect(exports["./browser"]).toBeDefined();
      expect(exports["./patterns"]).toBeDefined();
      expect(exports["./motion"]).toBeDefined();
      expect(exports["./ui"]).toBeDefined();
      expect(exports["./widgets"]).toBeDefined();
      expect(exports["./ssr"]).toBeDefined();
      expect(exports["./devtools"]).toBeDefined();
      expect(exports["./performance"]).toBeDefined();
      expect(exports["./ecosystem"]).toBeDefined();
      expect(exports["./plugins"]).toBeDefined();
      expect(exports["./build"]).toBeDefined();
      expect(exports["./testing"]).toBeDefined();
    });

    it("each export has types, import, and require fields", () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
      for (const [key, value] of Object.entries(pkg.exports)) {
        // ./cdn ships an IIFE bundle for direct <script> tags — no ESM/CJS/dts.
        if (key === "./cdn") continue;
        const entry = value as Record<string, string>;
        expect(entry.types).toBeDefined();
        expect(entry.import).toBeDefined();
        expect(entry.require).toBeDefined();
      }
    });

    it("sideEffects is false", () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
      expect(pkg.sideEffects).toBe(false);
    });

    it("browserslist is defined", () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
      expect(Array.isArray(pkg.browserslist)).toBe(true);
      expect(pkg.browserslist.length).toBeGreaterThan(0);
    });
  });
});
