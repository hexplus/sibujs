/**
 * The public surface contributed by `core/ssr-context`.
 *
 * WHAT WAS WRONG
 * --------------
 * `index.ts` re-exported the module with a wildcard:
 *
 *     export * from "./src/core/ssr-context";
 *
 * so when request-scoped i18n added the internal helper `getRequestStore()`, it
 * became part of the package's public API by accident — present in
 * `dist/index.js`, `dist/index.cjs`, both declaration files and the CDN global.
 * The helper hands back a MUTABLE `SSRStore`, so publishing it is a semver
 * commitment to an internal that exists only so `plugins/i18n.ts` can find the
 * current request.
 *
 * The wildcard is now an explicit list. This suite is what stops the next
 * internal addition from slipping out the same way: it pins the intended
 * surface exactly, in both directions.
 *
 * Package-level ESM/CJS/declaration/CDN inspection of the BUILT artefacts is
 * covered by `scripts/certify/exports-audit.mjs`; this file guards the source
 * barrel, which is where the mistake was made.
 */

import { describe, expect, it } from "vitest";
import * as ssrContext from "../src/core/ssr-context";

/**
 * Exactly what `core/ssr-context` published before the internal helper existed,
 * taken from `main` (47a95d9) rather than from intent.
 */
const PUBLIC_SSR_EXPORTS = [
  "disableSSR",
  "enableSSR",
  "getRequestScopedCache",
  "getSSRStore",
  "isSSR",
  "runInSSRContext",
  "withSSR",
] as const;

/** Internal to the framework: importable from `src/`, never from the package. */
const INTERNAL_SSR_EXPORTS = ["getRequestStore"] as const;

describe("the root barrel publishes exactly the intended SSR surface", () => {
  it("still exports every symbol that was public before this PR", async () => {
    const root = (await import("../index")) as Record<string, unknown>;
    const missing = PUBLIC_SSR_EXPORTS.filter((name) => !(name in root));
    expect(missing, "replacing the wildcard dropped a previously public export").toEqual([]);
  });

  it("does NOT export the internal request-store helper", async () => {
    const root = (await import("../index")) as Record<string, unknown>;
    for (const name of INTERNAL_SSR_EXPORTS) {
      expect(name in root, `${name} leaked into the public root barrel`).toBe(false);
    }
  });

  it("does not leak the helper through any other public entry point", async () => {
    // A different barrel could re-export it just as accidentally, so every
    // documented entry is checked rather than only the one that was wrong.
    const entries: [string, () => Promise<Record<string, unknown>>][] = [
      ["index", () => import("../index")],
      ["browser", () => import("../browser")],
      ["data", () => import("../data")],
      ["patterns", () => import("../patterns")],
      ["motion", () => import("../motion")],
      ["ui", () => import("../ui")],
      ["widgets", () => import("../widgets")],
      ["ssr", () => import("../ssr")],
      ["devtools", () => import("../devtools")],
      ["performance", () => import("../performance")],
      ["ecosystem", () => import("../ecosystem")],
      ["plugins", () => import("../plugins")],
      ["build", () => import("../build")],
      ["testing", () => import("../testing")],
      ["extras", () => import("../extras")],
      ["cdn", () => import("../cdn")],
    ];

    const leaked: string[] = [];
    for (const [name, load] of entries) {
      const mod = await load();
      for (const helper of INTERNAL_SSR_EXPORTS) {
        if (helper in mod) leaked.push(`${name} → ${helper}`);
      }
    }
    expect(leaked, "an internal helper is reachable from a public entry point").toEqual([]);
  });

  it("keeps the helper available INTERNALLY, which is why it exists", () => {
    // Removing it from the barrel must not remove it from the module: i18n
    // depends on it to find the current request's store.
    expect(typeof ssrContext.getRequestStore).toBe("function");
    // And it still answers correctly: null outside a request, the store inside.
    expect(ssrContext.getRequestStore()).toBeNull();
    const inside = ssrContext.runInSSRContext(() => ssrContext.getRequestStore());
    expect(inside).not.toBeNull();
    expect(inside?.ssr).toBe(true);
  });

  it("the public SSR exports still work through the root barrel", async () => {
    const root = await import("../index");
    // Not merely present — actually functional, so a stub or a renamed binding
    // would be caught too.
    expect(root.isSSR()).toBe(false);
    expect(root.runInSSRContext(() => root.isSSR())).toBe(true);
    expect(root.getSSRStore()).toBeTypeOf("object");
    expect(root.getRequestScopedCache("probe")).toBeNull();
    expect(root.runInSSRContext(() => root.getRequestScopedCache("probe"))).toBeInstanceOf(Map);
    expect(root.withSSR(() => root.isSSR())).toBe(true);
    root.enableSSR();
    expect(root.isSSR()).toBe(true);
    root.disableSSR();
    expect(root.isSSR()).toBe(false);
  });
});
