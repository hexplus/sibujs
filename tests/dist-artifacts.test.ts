// @vitest-environment node
//
// Nothing here needs a DOM: it reads built files and inspects strings.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Assertions against the REAL published artifacts, not against source.
//
// `treeshaking-dev-diagnostics.test.ts` proves that dev diagnostics CAN be
// compiled out: it bundles source with `__SIBU_DEV__: false` and checks the
// strings are gone. That is the right test for the ESM/CJS entry points, which
// are handed to a consumer's bundler to make that decision.
//
// It proves nothing about the CDN bundle, because nobody rebundles a
// `<script src="…/cdn.global.js">` — the published bytes ARE what runs. And it
// was in exactly that gap that the diagnostics shipped: the CDN build applied
// no `__SIBU_DEV__` define at all, so every warning string in the library rode
// along as dead weight (with no define and no `process` in a browser, the dev
// gate resolves to `false` at runtime — the text could never even print).
//
// So these tests read `dist/` directly. A define that silently stops being
// applied is not visible from source, and this is the only place it shows up.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");
const PROD_CDN = resolve(ROOT, "dist/cdn.global.js");
const DEV_CDN = resolve(ROOT, "dist/cdn.dev.global.js");

// Every diagnostic, identified by a literal only it emits, which survives
// minification verbatim. Keep in step with the marker list in
// `treeshaking-dev-diagnostics.test.ts`.
const DIAGNOSTIC_MARKERS = {
  "lone-string class heuristic": "looks like a class list",
  "duplicate node in reactive array": "duplicate node reference",
  "dropped style declaration": "was dropped by the style sanitizer",
  "blocked-construct explanation": "exfiltration channel",
  "focus lost on rebuild": "discarded the focused element",
  "ambiguous focus identity": "several elements in the rebuilt subtree",
  "when()/match() element-branch reuse": "branch was given as an element",
  "duplicate reactive runtime": "Multiple instances of the reactive runtime",
  "warning cap notice": "suppressing further",
  "thenable-setup explanation": "an unwrapped loader is called as a setup",
  "post-rollback context use": "was called after this enhancement was rolled back",
  "setup rejection explanation": "the promise returned by the setup also rejected",
} as const;

// `dist/` only exists after `npm run build`. Skipping locally keeps a plain
// `vitest` run working on a fresh clone; on CI a missing artifact is a failure,
// because CI always builds first and a silent skip there would hide exactly the
// regression this file exists to catch.
const built = existsSync(PROD_CDN) && existsSync(DEV_CDN);
const onCI = !!process.env.CI;

describe.skipIf(!built && !onCI)("published CDN artifacts", () => {
  it("both CDN bundles exist (run `npm run build` first)", () => {
    expect(existsSync(PROD_CDN), `missing ${PROD_CDN}`).toBe(true);
    expect(existsSync(DEV_CDN), `missing ${DEV_CDN}`).toBe(true);
  });

  it("the production CDN bundle contains NO diagnostic text", () => {
    const source = readFileSync(PROD_CDN, "utf8");
    for (const [name, marker] of Object.entries(DIAGNOSTIC_MARKERS)) {
      expect(
        source.includes(marker),
        `${name}: ${JSON.stringify(marker)} leaked into dist/cdn.global.js — a <script> consumer cannot strip it`,
      ).toBe(false);
    }
  });

  it("the development CDN bundle keeps every diagnostic", () => {
    // The counterpart guarantee. A no-build consumer opts into warnings by
    // loading this file instead; if the define were inverted, or this artifact
    // silently became a copy of the production one, the warnings would be gone
    // and nothing else would notice.
    const source = readFileSync(DEV_CDN, "utf8");
    for (const [name, marker] of Object.entries(DIAGNOSTIC_MARKERS)) {
      expect(source.includes(marker), `${name}: ${JSON.stringify(marker)} missing from dist/cdn.dev.global.js`).toBe(
        true,
      );
    }
  });

  it("the production CDN bundle is smaller than the development one", () => {
    // A cheap structural check that the two builds really are different
    // artifacts built with different defines, rather than the same bytes
    // written twice under two names.
    const prod = statSync(PROD_CDN).size;
    const dev = statSync(DEV_CDN).size;
    expect(prod).toBeLessThan(dev);
  });

  it("keeps the enhancement guard's own error message in production", () => {
    // The thenable guard is behaviour, not a diagnostic: it stops a broken
    // enhancement being reported as successful, so it must throw in production
    // too. Only its long explanation is traded away. If this string ever
    // disappears, the guard went with it.
    const source = readFileSync(PROD_CDN, "utf8");
    expect(source).toContain("setup returned a promise");
  });

  it("the production CDN bundle still self-registers on window", () => {
    // Stripping diagnostics must not strip the entry behaviour that makes this
    // artifact a CDN bundle at all.
    const source = readFileSync(PROD_CDN, "utf8");
    expect(source).toContain("Sibu");
  });
});

// ---------------------------------------------------------------------------
// What each CDN global actually carries, and where the boundary sits.
//
// `cdn.ts` used to re-export `./index` and nothing else, which made the
// no-build story quietly incomplete: islands are sold as "one script tag, no
// bundler", but an island reaching for `machine` found it missing, because it
// lives in the `sibujs/patterns` entry point that only a bundler can resolve.
//
// `sibujs/ui` is deliberately NOT in that bundle. It is the framework's
// UI-behaviour layer — forms, a11y primitives, virtual lists, transitions —
// which most pages never touch, and it stays bundler-only. These tests pin that
// boundary from the core side so a future merge has to be deliberate. These tests pin the boundary in both directions: the
// helpers that belong in core are present, and the ui surface is absent.
//
// They execute the published IIFEs and inspect the objects installed, rather
// than grepping for names — a string can survive minification while the export
// it belongs to does not.
// ---------------------------------------------------------------------------

/**
 * Run a published CDN bundle and return the global object it installs.
 *
 * The context object IS the global and `window` points back at it, matching a
 * browser where `window === globalThis`. That equivalence is the entire point:
 * an IIFE built with esbuild's `globalName` emits `var Sibu = <the module's
 * export namespace>` AFTER the module body has run. Against a separate `window`
 * stand-in the two land in different slots, so the test passes while the browser
 * gets the namespace instead of what the body installed — which is exactly the
 * bug this shape was written to catch.
 */
function loadCdnGlobal(file: string): Record<string, unknown> {
  const context = createContext({ console }) as Record<string, unknown>;
  context.window = context;
  runInContext(readFileSync(file, "utf8"), context);
  return context.Sibu as Record<string, unknown>;
}

describe.skipIf(!built && !onCI)("the core CDN global", () => {
  it("self-registers an object on window", () => {
    expect(typeof loadCdnGlobal(PROD_CDN)).toBe("object");
  });

  it("carries the patterns helpers a no-build island cannot otherwise reach", () => {
    const Sibu = loadCdnGlobal(PROD_CDN);
    expect(typeof Sibu.machine).toBe("function");
    expect(typeof (Sibu.patterns as Record<string, unknown>).machine).toBe("function");
  });

  it("does NOT carry the ui behaviour layer", () => {
    // The boundary, asserted from the core side: merging `sibujs/ui` in would
    // make every no-build consumer download forms, virtual lists and
    // transitions to get `signal`.
    const Sibu = loadCdnGlobal(PROD_CDN);
    expect(Sibu.createDialogAria).toBeUndefined();
    expect(Sibu.createFocusManager).toBeUndefined();
    expect(Sibu.ui).toBeUndefined();
  });

  it("keeps `dialog` and `form` as the element tag factories", async () => {
    // `sibujs/ui` exports its own `dialog` and `form`, and they are NOT the tag
    // factories of the same name. Keeping the bundles apart is what stops that
    // ambiguity reaching `Sibu`; if the two are ever merged, this fails.
    //
    // Identified by arity rather than by calling them: a tag factory needs a
    // DOM, and identity comparison is meaningless across a separate bundle.
    // Minification preserves parameter count.
    const Sibu = loadCdnGlobal(PROD_CDN);
    const core = (await import("../dist/index.js")) as unknown as Record<string, () => void>;
    const ui = (await import("../dist/ui.js")) as unknown as Record<string, () => void>;

    // The premise this test rests on, asserted rather than assumed.
    expect(ui.dialog).not.toBe(core.dialog);
    expect(core.dialog.length).not.toBe(ui.dialog.length);
    expect(core.form.length).not.toBe(ui.form.length);

    expect((Sibu.dialog as () => void).length).toBe(core.dialog.length);
    expect((Sibu.form as () => void).length).toBe(core.form.length);
  });
});
