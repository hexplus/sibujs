# SibuJS v4 — Phase 2 Implementation Plan (Surface Tiering → @sibujs/labs)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split the `sibujs` package's 12 source domains into a small first-party std tier (`sibujs`) and an opt-in long-tail tier (`@sibujs/labs`), so the maintained surface matches maintenance capacity.

**Architecture:** New `@sibujs/labs` package sits at the top of the dependency stack — it depends on `@sibujs/core` and `sibujs`, and nothing depends on it. The 7 labs domains move out of `packages/sibujs/src` into `packages/labs/src`; their subpath entries become `@sibujs/labs/*`. std entry barrels that referenced labs domains are trimmed.

**Tech Stack:** TypeScript, pnpm workspaces, tsup, vitest, biome.

**Depends on:** Phase 0–1 complete (workspace + `@sibujs/core` extracted). **Commit Phase 0–1 before starting.**

---

## Confirmed tiering (from the Phase 2 audit)

Source-level cross-domain dependency graph (only 3 edges, all point std-ward — no std domain imports a labs domain):
```
ecosystem  → plugins (std)
performance → platform (std)
plugins    → platform (std)   [both std]
```

| Tier | Domains | Entry points |
| --- | --- | --- |
| **std** (`sibujs`) | data, plugins, platform(ssr), ui, build, testing | index, data, ui, ssr, plugins, build, testing |
| **labs** (`@sibujs/labs`) | browser (33f), widgets, patterns, ecosystem, performance, devtools, motion (6 files in src/ui) | browser, widgets, patterns, ecosystem, performance, devtools, motion, extras |

**Labs external deps:** `@sibujs/core` (all domains, already rewritten in Phase 1) + `sibujs` (ecosystem→plugins, performance→platform, motion→ui).

**Known straddles (resolve during move):**
- `ui.ts` (std) re-exports `patterns/{composable,hoc,componentProps,contracts}` → drop those lines (patterns → labs). *Breaking: those symbols move to `@sibujs/labs/patterns`.*
- `extras.ts` (the "all advanced features" barrel) re-exports labs domains → move to `@sibujs/labs` as its aggregate entry; remove from std.
- `motion` = 6 files in `src/ui/` (`transition`, `animationPresets`, `TransitionGroup`, `viewTransition`, `reducedMotion`, `springSignal`) → move to `packages/labs/src/motion/`; std `ui/` source does not import them (verified).

---

## Task 2.0: Scaffold @sibujs/labs

**Files:** `packages/labs/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`

- [ ] **Step 1: `packages/labs/package.json`** — name `@sibujs/labs`, version `4.0.0-alpha.0`, deps `{ "@sibujs/core": "workspace:*", "sibujs": "workspace:*" }`, subpath `exports` for `./browser ./widgets ./patterns ./ecosystem ./performance ./devtools ./motion .` (`.` = extras aggregate). Build script mirrors std:
```
tsup browser.ts widgets.ts patterns.ts ecosystem.ts performance.ts devtools.ts motion.ts index.ts --dts --format esm,cjs --out-dir dist --clean
```

- [ ] **Step 2: `packages/labs/tsconfig.json`** — `extends ../../tsconfig.base.json`, `include ["*.ts","src/**/*.ts"]`.

- [ ] **Step 3: `packages/labs/tsup.config.ts`** — copy std's: `__SIBU_VERSION__` define, `external: [/^@sibujs\/core/, /^sibujs/]`, **`splitting: false`** (same esbuild `export *`-across-entries fix learned in Phase 1).

- [ ] **Step 4: `packages/labs/vitest.config.ts`** — jsdom, `include ["tests/**/*.test.ts"]`.

- [ ] **Step 5:** `pnpm install`; verify `@sibujs/labs` is a linked workspace package.

## Task 2.1: Move labs domain sources

- [ ] **Step 1:** `git mv` domain dirs `packages/sibujs/src/{browser,widgets,patterns,ecosystem,performance,devtools}` → `packages/labs/src/`.
- [ ] **Step 2:** Extract motion: `mkdir packages/labs/src/motion`; `git mv` the 6 motion files from `packages/sibujs/src/ui/` → `packages/labs/src/motion/`.
- [ ] **Step 3:** Typecheck labs (`cd packages/labs && tsc --noEmit`) to enumerate unresolved cross-tier imports. Expected: `../plugins/*` (ecosystem), `../platform/*` (performance), `../ui/*` (motion), and any `../<siblinglabsdomain>`.

## Task 2.2: Rewire cross-tier imports (labs → std)

**Codemod** `packages/labs/src` + tests. Map now-dangling relative imports to `sibujs` subpaths:
- `(../)+plugins/<x>` → `sibujs/plugins`
- `(../)+platform/<ssr|head|…>` → `sibujs/ssr`
- `(../)+ui/<x>` → `sibujs/ui`  (motion's deps on ui utilities)
- `(../)+data/<x>` → `sibujs/data` (if any)

- [ ] **Step 1:** Write/adapt the Phase-1-style Node codemod (`classify()` mapping relative std-domain specifiers → `sibujs/<subpath>`), run over `packages/labs`.
- [ ] **Step 2:** Re-typecheck labs → 0 unresolved cross-tier imports. Engine imports (`@sibujs/core[/internal]`) already correct from Phase 1 — no change.

## Task 2.3: Move labs entry files + build barrels

- [ ] **Step 1:** `git mv` `packages/sibujs/{browser,widgets,patterns,ecosystem,performance,devtools,motion,extras}.ts` → `packages/labs/`. Rename `extras.ts` → `index.ts` (labs aggregate) OR keep `extras.ts` and add a thin `index.ts` that re-exports it.
- [ ] **Step 2:** Fix internal paths in those entry files (they use `./src/<domain>/…` which now resolves under `packages/labs`). The domains that stayed std but were referenced by `extras`/`ui` (e.g. `ui/form`, `platform/head`) must import from `sibujs` subpaths instead of `./src`.
- [ ] **Step 3:** Ensure `motion.ts` points at `./src/motion/*` (moved location).

## Task 2.4: Trim std entry barrels + package.json

- [ ] **Step 1:** `ui.ts` — remove the 4 `./src/patterns/*` re-export lines.
- [ ] **Step 2:** Delete std `extras.ts`, `browser.ts`, `widgets.ts`, `patterns.ts`, `ecosystem.ts`, `performance.ts`, `devtools.ts`, `motion.ts` (moved to labs).
- [ ] **Step 3:** `packages/sibujs/package.json` — remove `exports` + build entries for `./browser ./widgets ./patterns ./ecosystem ./performance ./devtools ./motion ./extras`. Update the `build` script's entry list to drop those.
- [ ] **Step 4:** Grep std `src` + remaining entries for any lingering `@sibujs/labs`-domain references → 0 (std must not depend on labs).

## Task 2.5: Move labs tests

- [ ] **Step 1:** Classify `packages/sibujs/tests` by domain (reuse Phase-1 classifier logic): tests exercising only labs domains → `git mv` to `packages/labs/tests`.
- [ ] **Step 2:** Codemod moved tests' imports: `../src/<labsdomain>` stays relative (resolves under labs); `../src/<stddomain>` → `sibujs/<subpath>`; engine → already `@sibujs/core`.
- [ ] **Step 3:** Mixed std+labs tests: keep in std, rewrite labs-domain imports → `@sibujs/labs/<subpath>`.

## Task 2.6: Build, typecheck, test — full green

- [ ] **Step 1:** `pnpm install` (link labs).
- [ ] **Step 2:** Build order: `@sibujs/core` → `sibujs` → `@sibujs/labs` (labs consumes both). `pnpm -r build` (pnpm resolves order via workspace deps).
- [ ] **Step 3:** `pnpm -r exec tsc --noEmit` → 0 errors all three packages.
- [ ] **Step 4:** `pnpm -r test -- --run` → core + std + labs all green. Reconcile: total tests = Phase-1 total (4000) ± intentional; **no test loss**.
- [ ] **Step 5:** Contract checks: `import { machine } from "@sibujs/labs/patterns"`, `import { media } from "@sibujs/labs/browser"` resolve; `import { signal, query, createRouter } from "sibujs"`+`"sibujs/data"`+`"sibujs/plugins"` still work.

## Task 2.7: Acceptance

- [ ] Frozen install; full `pnpm -r` typecheck+test+build green; verify std package.json no longer exports labs subpaths and labs package.json exports all 7 + aggregate.

---

## Self-Review
- **Coverage:** creates labs (2.0), moves sources (2.1) + entries (2.3) + tests (2.5), rewires cross-tier (2.2), trims std (2.4), verifies (2.6–2.7). Split matches audit + user decision.
- **Dependency direction:** labs→{core,std} only; Task 2.4 Step 4 asserts no std→labs edge remains.
- **Reused Phase-1 learnings:** `splitting:false` + `external` in labs tsup; codemod pattern; test-classifier; build-before-typecheck for cross-package dist resolution.
- **Breaking changes (v4, migration guide):** `sibujs/extras`, `sibujs/browser`, `sibujs/widgets`, `sibujs/patterns`, `sibujs/motion`, `sibujs/performance`, `sibujs/devtools`, `sibujs/ecosystem` → `@sibujs/labs/*`; `composable`/`hoc` leave `sibujs/ui`.
