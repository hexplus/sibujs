// @vitest-environment node
//
// Nothing here needs a DOM: it reads built files and inspects strings.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
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

  it("the production CDN bundle still self-registers on window", () => {
    // Stripping diagnostics must not strip the entry behaviour that makes this
    // artifact a CDN bundle at all.
    const source = readFileSync(PROD_CDN, "utf8");
    expect(source).toContain("Sibu");
  });
});
