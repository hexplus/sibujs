// @vitest-environment node
//
// Nothing here needs a DOM: it reads built files and inspects strings.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { gzipSync } from "node:zlib";
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
const FULL_CDN = resolve(ROOT, "dist/cdn.full.global.js");
const FULL_DEV_CDN = resolve(ROOT, "dist/cdn.full.dev.global.js");

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

// Diagnostics that live in `sibujs/patterns`, so they only appear in the
// bundles that carry it. `validateProps` gated on `process.env.NODE_ENV`
// until 4.4.0 — not a `define` target, and absent in a browser, so the check
// ran and warned in every browser build. Nothing caught it because this list
// is hand-maintained; the behavioural tests below are the real guard.
const PATTERNS_DIAGNOSTIC_MARKERS = {
  "prop validation errors": "Prop validation errors",
  // The assertion body, which survived the first fix: gating on the imported
  // `DEV` const folded the condition to `!1` but left `if (!1) { … }` standing,
  // because the const is substituted after dead-code elimination has run.
  "contract assertion": "[SibuJS Contract]",
} as const;

// NOT markers, and worth saying so: `validators.required` and `validators.oneOf`
// build the strings "… is required" and "… must be one of:" as their RETURN
// VALUES. They are exported API that runs in production, so those strings must
// ship. Asserting their absence would be asserting the library is broken.

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

const fullBuilt = existsSync(FULL_CDN) && existsSync(FULL_DEV_CDN);

describe.skipIf(!built && !onCI)("the default CDN global", () => {
  it("self-registers an object on window", () => {
    expect(typeof loadCdnGlobal(PROD_CDN)).toBe("object");
  });

  it("carries core and nothing else", () => {
    // This is the file every no-build page downloads, so anything merged in is
    // paid for by consumers who never call it. `patterns` cost +13% gzip on its
    // own, which is why it ships as `cdn.full.global.js` instead.
    const Sibu = loadCdnGlobal(PROD_CDN);
    expect(typeof Sibu.signal).toBe("function");
    expect(Sibu.machine).toBeUndefined();
    expect(Sibu.patterns).toBeUndefined();
    expect(Sibu.ui).toBeUndefined();
    expect(Sibu.createDialogAria).toBeUndefined();
  });

  it("stays within its byte budget, over the wire and on disk", () => {
    // 80,202 B raw / 26,330 B gzip was the size before patterns was merged in
    // and then split back out. The default bundle must not drift above that
    // without someone deciding to; a review caught exactly that drift once.
    //
    // GZIP IS THE ONE THAT MATTERS, and it is not implied by the raw number:
    // bytes that compress badly can push the transfer size up while the file
    // on disk stays flat or shrinks. Level 9 keeps this deterministic, and the
    // 2% tolerance absorbs differences between zlib builds rather than real
    // growth — it is far tighter than the 13% regression this guards against.
    const raw = statSync(PROD_CDN).size;
    const gzip = gzipSync(readFileSync(PROD_CDN), { level: 9 }).length;
    expect(raw, `raw ${raw} B`).toBeLessThanOrEqual(80_202);
    expect(gzip, `gzip ${gzip} B`).toBeLessThanOrEqual(Math.round(26_330 * 1.02));
  });
});

describe.skipIf(!fullBuilt && !onCI)("the core + patterns CDN global", () => {
  it("both full bundles exist (run `npm run build` first)", () => {
    expect(existsSync(FULL_CDN), `missing ${FULL_CDN}`).toBe(true);
    expect(existsSync(FULL_DEV_CDN), `missing ${FULL_DEV_CDN}`).toBe(true);
  });

  it("carries the patterns surface a no-build page cannot otherwise reach", () => {
    const Sibu = loadCdnGlobal(FULL_CDN);
    expect(typeof Sibu.machine).toBe("function");
    expect(typeof (Sibu.patterns as Record<string, unknown>).machine).toBe("function");
    expect(typeof Sibu.signal).toBe("function");
  });

  it("lets core win every name collision", async () => {
    // Identified by arity rather than by calling them: a tag factory needs a
    // DOM, and identity comparison is meaningless across a separate bundle.
    // Minification preserves parameter count.
    const Sibu = loadCdnGlobal(FULL_CDN);
    const core = (await import("../dist/index.js")) as unknown as Record<string, () => void>;
    const ui = (await import("../dist/ui.js")) as unknown as Record<string, () => void>;

    // The premise this test rests on, asserted rather than assumed.
    expect(ui.dialog).not.toBe(core.dialog);
    expect(core.dialog.length).not.toBe(ui.dialog.length);

    expect((Sibu.dialog as () => void).length).toBe(core.dialog.length);
    expect((Sibu.form as () => void).length).toBe(core.form.length);
  });

  it("compiles the patterns diagnostics out of production", () => {
    const prod = readFileSync(FULL_CDN, "utf8");
    const dev = readFileSync(FULL_DEV_CDN, "utf8");
    for (const [name, marker] of Object.entries(PATTERNS_DIAGNOSTIC_MARKERS)) {
      expect(prod, `${name} survived into the production bundle`).not.toContain(marker);
      expect(dev, `${name} is missing from the development bundle`).toContain(marker);
    }
  });

  // The tests that actually matter: the marker list above is hand-maintained
  // and missed this for a whole release. These run the published bytes.
  it("validateProps neither validates nor warns in production", () => {
    const warnings: string[] = [];
    const context = createContext({
      console: { warn: (...a: unknown[]) => warnings.push(a.join(" ")), error() {}, log() {} },
    }) as Record<string, unknown>;
    context.window = context;
    runInContext(readFileSync(FULL_CDN, "utf8"), context);
    const Sibu = context.Sibu as Record<string, never>;
    const validators = Sibu.validators as unknown as Record<string, unknown>;

    const out = (Sibu.validateProps as unknown as (p: object, s: object) => Record<string, unknown>)(
      { n: "not a number" },
      { n: { type: validators.number, required: true } },
    );

    expect(warnings).toEqual([]);
    // Defaults still applied, value untouched: only the checking disappears.
    expect(out.n).toBe("not a number");
  });

  it("validateProps does warn in the development bundle", () => {
    // The negative above is only meaningful if the positive holds.
    const warnings: string[] = [];
    const context = createContext({
      console: { warn: (...a: unknown[]) => warnings.push(a.join(" ")), error() {}, log() {} },
    }) as Record<string, unknown>;
    context.window = context;
    runInContext(readFileSync(FULL_DEV_CDN, "utf8"), context);
    const Sibu = context.Sibu as Record<string, never>;
    const validators = Sibu.validators as unknown as Record<string, unknown>;

    (Sibu.validateProps as unknown as (p: object, s: object) => unknown)(
      { n: "not a number" },
      { n: { type: validators.number, required: true } },
    );

    expect(warnings.join(" ")).toContain("Prop validation errors");
  });

  it("validateProps does not invoke validators at all in production", () => {
    // Stronger than "it did not warn": a spy proves the validation branch never
    // ran, rather than running silently. Silence would still mean the work and
    // the code were shipped.
    const calls = { prod: 0, dev: 0 };
    const spy = (where: "prod" | "dev") => () => {
      calls[where] += 1;
      return "always invalid" as const;
    };

    const run = (file: string, where: "prod" | "dev") => {
      const Sibu = loadCdnGlobal(file);
      (Sibu.validateProps as unknown as (p: object, s: object) => unknown)(
        { n: 1 },
        { n: { type: spy(where), required: true } },
      );
    };

    run(FULL_CDN, "prod");
    run(FULL_DEV_CDN, "dev");

    expect(calls.prod, "a validator ran in the production bundle").toBe(0);
    // The positive control: without it, a `validateProps` that silently did
    // nothing anywhere would pass the assertion above.
    expect(calls.dev, "no validator ran in the development bundle").toBeGreaterThan(0);
  });

  it("validateProps allocates nothing for the development path in production", () => {
    // The dev-only `errors` array used to be declared above the loop that fills
    // it, which is outside the foldable branch — so the branch stripped cleanly
    // and left `let r = []` allocated on every production call, forever unread.
    //
    // Asserted against the SHIPPED function rather than the source, because
    // this is a property of what the minifier emitted, not of what was written.
    //
    // Reading `toString()` only sees this function's own body, so it is only a
    // sufficient guard while both paths are inlined here. A shared helper hid a
    // `{ type: def }` normalization from exactly this assertion once — hence
    // the second check, and the comment in `contracts.ts` saying why the
    // duplication there is deliberate.
    const Sibu = loadCdnGlobal(FULL_CDN);
    const source = (Sibu.validateProps as unknown as () => void).toString();
    expect(source, `production validateProps allocates an array: ${source}`).not.toMatch(/\[\s*\]/);
    expect(source, `production validateProps normalizes for validation: ${source}`).not.toContain("type:");
  });

  it("assertType is a no-op in production and throws in development", () => {
    const call = (file: string) => {
      const Sibu = loadCdnGlobal(file);
      const validators = Sibu.validators as Record<string, unknown>;
      (Sibu.assertType as (v: unknown, val: unknown, l?: string) => void)("nope", validators.number, "n");
    };
    // It guarded on `process.env.NODE_ENV`, which does not exist in a browser,
    // so the early return never fired and this threw on every CDN page.
    expect(() => call(FULL_CDN)).not.toThrow();
    expect(() => call(FULL_DEV_CDN)).toThrow(/Contract/);
  });
});
