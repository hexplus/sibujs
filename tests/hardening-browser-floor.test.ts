/**
 * Browser-support floor gate.
 *
 * `package.json#browserslist` is a PROMISE about which engines the published
 * bundle runs on. Nothing enforced it, so the source drifted above the declared
 * floor and the promise quietly became false — a consumer targeting the
 * declared minimum ships a bundle that throws on first use.
 *
 * This gate closes that loop permanently: every modern platform API the source
 * uses WITHOUT a feature-detection guard must be available at the declared
 * floor. Adding such an API now forces a deliberate decision — guard it, or
 * raise the floor and update the published support matrix.
 *
 * Baseline versions below are from MDN/caniuse compatibility data. `Infinity`
 * means "never shipped in that engine", which is only acceptable behind a
 * guard.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ApiBaseline {
  /** Human-readable API name. */
  name: string;
  /** Source pattern that indicates a *call/usage* of the API. */
  pattern: RegExp;
  /** Minimum engine versions that implement it. */
  since: { chrome: number; edge: number; firefox: number; safari: number };
  /**
   * Token that marks the API as feature-detected. Matched against the WHOLE
   * file: a module that tests for an API before reaching for it has made the
   * availability decision deliberately, and its fallback path is what runs on
   * older engines — so it never constrains the floor. Proximity matching was
   * tried first and is too brittle: real guards legitimately sit at the top of
   * a `desired`-tier computation many lines above the call site.
   */
  guards?: RegExp;
}

const BASELINES: ApiBaseline[] = [
  {
    name: "ParentNode.replaceChildren()",
    pattern: /\.replaceChildren\s*\(/,
    since: { chrome: 86, edge: 86, firefox: 78, safari: 14 },
  },
  {
    name: "Object.hasOwn()",
    pattern: /\bObject\.hasOwn\s*\(/,
    since: { chrome: 93, edge: 93, firefox: 92, safari: 15.4 },
  },
  {
    name: "structuredClone()",
    pattern: /\bstructuredClone\s*\(/,
    since: { chrome: 98, edge: 98, firefox: 94, safari: 15.4 },
    guards: /typeof structuredClone/,
  },
  {
    name: "queueMicrotask()",
    pattern: /\bqueueMicrotask\s*\(/,
    since: { chrome: 71, edge: 79, firefox: 69, safari: 12.1 },
    guards: /typeof queueMicrotask/,
  },
  {
    name: "requestIdleCallback()",
    pattern: /\brequestIdleCallback\s*\(/,
    since: { chrome: 47, edge: 79, firefox: 55, safari: 15.4 },
    guards: /typeof requestIdleCallback|typeof g\.requestIdleCallback|requestIdleCallback\?:/,
  },
  {
    name: "ResizeObserver",
    pattern: /\bnew ResizeObserver\s*\(/,
    since: { chrome: 64, edge: 79, firefox: 69, safari: 13.1 },
    guards: /typeof ResizeObserver/,
  },
  {
    name: "IntersectionObserver",
    pattern: /\bnew IntersectionObserver\s*\(/,
    since: { chrome: 51, edge: 15, firefox: 55, safari: 12.1 },
    guards: /typeof IntersectionObserver/,
  },
  {
    name: "AggregateError",
    pattern: /\bnew AggregateError\s*\(|\bAggregateError\s*\(/,
    since: { chrome: 85, edge: 85, firefox: 79, safari: 14 },
    guards: /AggregateError\?:|globalThis as \{ AggregateError|const Agg\b|Agg\s*\?/,
  },
  {
    name: "Error cause option",
    pattern: /new Error\([^)]*\{\s*cause:/,
    since: { chrome: 93, edge: 93, firefox: 91, safari: 15 },
  },
  {
    name: "CSS.escape()",
    pattern: /\bCSS\.escape\s*\(/,
    since: { chrome: 46, edge: 79, firefox: 31, safari: 10 },
    guards: /typeof CSS|typeof g\.CSS|g\.CSS &&/,
  },
  {
    name: "document.startViewTransition()",
    pattern: /\.startViewTransition\s*\(/,
    since: { chrome: 111, edge: 111, firefox: 129, safari: 18 },
    guards: /"startViewTransition" in document|typeof \(document/,
  },
  {
    name: "Promise.allSettled()",
    pattern: /\bPromise\.allSettled\s*\(/,
    since: { chrome: 76, edge: 79, firefox: 71, safari: 13 },
  },
  {
    name: "Object.fromEntries()",
    pattern: /\bObject\.fromEntries\s*\(/,
    since: { chrome: 73, edge: 79, firefox: 63, safari: 12.1 },
  },
  {
    name: "String.prototype.matchAll()",
    pattern: /\.matchAll\s*\(/,
    since: { chrome: 73, edge: 79, firefox: 67, safari: 13 },
  },
  {
    name: "globalThis",
    pattern: /\bglobalThis\b/,
    since: { chrome: 71, edge: 79, firefox: 65, safari: 12.1 },
  },
  {
    name: "AbortController / AbortSignal",
    pattern: /\bnew AbortController\s*\(/,
    since: { chrome: 66, edge: 16, firefox: 57, safari: 11.1 },
  },
  {
    name: "crypto.randomUUID()",
    pattern: /\bcrypto\.randomUUID\s*\(/,
    since: { chrome: 92, edge: 92, firefox: 95, safari: 15.4 },
    guards: /typeof crypto|crypto\?\./,
  },
  {
    name: "WeakRef",
    pattern: /\bnew WeakRef\s*\(/,
    since: { chrome: 84, edge: 84, firefox: 79, safari: 14.1 },
    guards: /typeof WeakRef/,
  },
  {
    name: "FinalizationRegistry",
    pattern: /\bnew FinalizationRegistry\s*\(/,
    since: { chrome: 84, edge: 84, firefox: 79, safari: 14.1 },
    guards: /typeof FinalizationRegistry/,
  },
  {
    name: "URLPattern",
    pattern: /\bnew URLPattern\s*\(/,
    since: { chrome: 95, edge: 95, firefox: Number.POSITIVE_INFINITY, safari: 18 },
    guards: /typeof URLPattern/,
  },
  {
    name: "Element.toggleAttribute()",
    pattern: /\.toggleAttribute\s*\(/,
    since: { chrome: 69, edge: 79, firefox: 63, safari: 12 },
  },
  {
    name: "AbortSignal.timeout()",
    pattern: /\bAbortSignal\.timeout\s*\(/,
    since: { chrome: 103, edge: 103, firefox: 100, safari: 16 },
    guards: /typeof AbortSignal/,
  },
  {
    name: "AbortSignal.any()",
    pattern: /\bAbortSignal\.any\s*\(/,
    since: { chrome: 116, edge: 116, firefox: 124, safari: 17.4 },
    guards: /typeof AbortSignal/,
  },
];

const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Strip line/block comments so prose mentioning an API is not counted as a
 * "usage". Newlines inside block comments are preserved so reported line
 * numbers still point at the real source line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface Usage {
  file: string;
  line: number;
  text: string;
}

function findUnguardedUsages(api: ApiBaseline, files: string[]): Usage[] {
  const usages: Usage[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const stripped = stripComments(raw);
    // File-level guard: this module feature-detects the API, so its usages run
    // only where the API exists and its fallback covers older engines.
    if (api.guards?.test(stripped)) continue;
    const lines = stripped.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!api.pattern.test(lines[i])) continue;
      usages.push({ file: file.slice(SRC.length + 1).replace(/\\/g, "/"), line: i + 1, text: lines[i].trim() });
    }
  }
  return usages;
}

function declaredFloor(): { chrome: number; edge: number; firefox: number; safari: number } {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    browserslist: string[];
  };
  const floor: Record<string, number> = {};
  for (const entry of pkg.browserslist) {
    const m = entry.match(/^(\w+)\s*>=\s*([\d.]+)$/i);
    expect(m, `browserslist entry "${entry}" must be of the form "Name >= version"`).not.toBeNull();
    if (m) floor[m[1].toLowerCase()] = Number.parseFloat(m[2]);
  }
  return floor as unknown as { chrome: number; edge: number; firefox: number; safari: number };
}

describe("browser support floor", () => {
  const files = walk(SRC);
  const floor = declaredFloor();

  it("declares a floor for every engine the gate checks", () => {
    for (const engine of ["chrome", "edge", "firefox", "safari"] as const) {
      expect(Number.isFinite(floor[engine]), `browserslist must declare a minimum for ${engine}`).toBe(true);
    }
  });

  for (const api of BASELINES) {
    it(`${api.name} is available at the declared floor wherever it is used unguarded`, () => {
      const usages = findUnguardedUsages(api, files);
      if (usages.length === 0) return;

      const violations: string[] = [];
      for (const engine of ["chrome", "edge", "firefox", "safari"] as const) {
        if (api.since[engine] > floor[engine]) {
          violations.push(`${engine} >= ${floor[engine]} declared, but ${api.name} needs ${api.since[engine]}`);
        }
      }

      expect(
        violations,
        `${api.name} is used without a feature guard at:\n` +
          usages.map((u) => `  ${u.file}:${u.line}  ${u.text}`).join("\n") +
          "\n\nEither guard the usage, or raise the browserslist floor AND update " +
          "docs/support-matrix.md, README.md and the changelog.",
      ).toEqual([]);
    });
  }
});
