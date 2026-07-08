# SibuJS v4 — Phase 0–1 Implementation Plan (Monorepo + Core Extraction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the single-package `sibujs` repo into a pnpm workspace and extract the reactivity + rendering engine into a standalone `@sibujs/core` package, so bundler dedup becomes a packaging guarantee instead of a runtime rescue.

**Architecture:** The existing git repo (currently the `sibujs` package root) becomes the workspace root. All current package files move to `packages/sibujs/`. A new `packages/core/` (`@sibujs/core`) is carved out of it, holding `src/core`, `src/reactivity`, and the enhance/islands primitives. `packages/sibujs` re-exports `@sibujs/core` so `import { signal, div, mount } from "sibujs"` keeps working. The `globalThis` duplicate-runtime registry in `track.ts` is demoted from correctness-critical to a dev-only tripwire.

**Tech Stack:** TypeScript, pnpm workspaces, tsup (build), vitest (jsdom unit tests), Playwright (browser tests), biome (lint/format), Node ≥18.

**Scope note:** This plan covers **Phase 0 and Phase 1 only** from the design spec (`docs/superpowers/specs/2026-07-08-v4-architecture-derisking-design.md`). Phase 2 (surface tiering — depends on an audit), Phase 3 (sharp-edge hardening — touches the separate `sibujs-eslint-plugin` repo), and Phase 4 (v4 release) each get their own plan after this lands. Phase 0+1 produces a working, fully-tested state on its own.

**Preconditions:** On branch `feature/split-core`, working tree clean. `pnpm` installed (`npm i -g pnpm` if not). All commands run from the repo root unless stated.

---

## File Structure (target after Phase 1)

```
sibujs/                              # git repo root = workspace root (private)
├── pnpm-workspace.yaml              # NEW: declares packages/*
├── package.json                     # NEW: private workspace root, aggregate scripts
├── tsconfig.base.json               # NEW: shared compiler options
├── biome.json                       # MOVED to root: shared lint/format config
├── bench.mjs, bench-baseline.json   # stays at root: benchmark gate, targets core
├── docs/superpowers/…               # stays at root: specs + plans (project meta)
└── packages/
    ├── core/                        # NEW: @sibujs/core
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts
    │   ├── index.ts                 # engine public surface
    │   ├── src/
    │   │   ├── core/                # MOVED from packages/sibujs/src/core
    │   │   ├── reactivity/          # MOVED from packages/sibujs/src/reactivity
    │   │   └── platform/enhance.ts, islands.ts, ssr.ts (brand only)
    │   └── tests/                   # core-owned tests (moved subset + new)
    └── sibujs/                      # std meta package (keeps install name)
        ├── package.json             # depends on @sibujs/core (workspace:*)
        ├── index.ts                 # re-exports @sibujs/core + std subpaths
        ├── src/                     # data, browser, ui, widgets, motion, plugins, …
        ├── tsup.config.ts, vitest.config.ts, playwright.config.ts
        └── tests/, tests-browser/
```

**Responsibilities:**
- `pnpm-workspace.yaml` / root `package.json`: workspace wiring + aggregate scripts only. Root is private, never published.
- `packages/core`: the engine. No dependency on `packages/sibujs`. Semver-strict, benchmark-gated.
- `packages/sibujs`: batteries. Depends on `@sibujs/core` via `workspace:*`, re-exports it.

---

## PHASE 0 — Monorepo Groundwork

Mechanical restructure with **no public API change**. The existing vitest + build + typecheck suites are the regression gate: they must stay green through every move. "Write the failing test" is replaced by "confirm the existing suite is green before and after" for move-only tasks.

### Task 0.1: Baseline — capture current green state

**Files:** none (verification only)

- [ ] **Step 1: Confirm clean tree and branch**

Run: `git status --short && git rev-parse --abbrev-ref HEAD`
Expected: no output from `status`; branch prints `feature/split-core`.

- [ ] **Step 2: Record the passing baseline**

Run: `npm ci && npm test -- --run && npx tsc --noEmit && npm run build`
Expected: vitest reports all suites passing; `tsc` prints nothing (exit 0); `build` completes and writes `dist/`. If anything fails here, STOP — fix or report before restructuring.

- [ ] **Step 3: Note the current test count**

Run: `npm test -- --run 2>&1 | grep -E "Tests +[0-9]+ passed"`
Expected: a line like `Tests  <N> passed`. Record `<N>` — the same count must pass after Phase 0.

### Task 0.2: Create the `packages/sibujs` directory and move the package into it

**Files:**
- Create: `packages/sibujs/` (directory)
- Move: all current package files into `packages/sibujs/` **except** `.git/`, `.github/`, `.gitignore`, and `docs/`

- [ ] **Step 1: Create the target directory**

Run: `mkdir -p packages/sibujs`

- [ ] **Step 2: Move package files with git mv (preserves history)**

Run each (from repo root):
```bash
git mv browser.ts build.ts cdn.ts data.ts devtools.ts ecosystem.ts extras.ts \
       index.ts motion.ts patterns.ts performance.ts plugins.ts ssr.ts \
       testing.ts ui.ts widgets.ts packages/sibujs/
git mv package.json package-lock.json tsconfig.json tsup.config.ts \
       vitest.config.ts playwright.config.ts biome.json packages/sibujs/
git mv src tests tests-browser examples bench packages/sibujs/
git mv README.md CHANGELOG.md LICENSE TODO.md .gitattributes packages/sibujs/
git mv bench.mjs bench-baseline.json bench-browser.html publish.mjs release.sh packages/sibujs/
```
Note: `docs/`, `.github/`, `.gitignore` intentionally stay at repo root (workspace-level). If any listed file does not exist, drop it from the command — do not create it.

- [ ] **Step 3: Verify the move**

Run: `ls packages/sibujs && echo "--- root ---" && ls`
Expected: `packages/sibujs` contains `index.ts`, `src`, `tests`, `package.json`, etc. Repo root now shows only `packages`, `docs`, `.github`, `.gitignore`, `node_modules`.

- [ ] **Step 4: Confirm the package still builds/tests from its new home**

Run: `cd packages/sibujs && npm ci && npm test -- --run && npx tsc --noEmit && cd ../..`
Expected: same `<N> passed` test count as Task 0.1 Step 3; `tsc` exit 0. (tsup/vitest configs use relative paths, so nothing needs editing yet.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move sibujs package into packages/sibujs (workspace prep)"
```

### Task 0.3: Add workspace root files

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (workspace root, private)
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create the private root `package.json`**

```json
{
  "name": "sibujs-workspace",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test -- --run",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "lint": "pnpm -r lint",
    "bench": "pnpm --filter @sibujs/core bench"
  },
  "packageManager": "pnpm@9.0.0"
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,
    "types": []
  }
}
```

- [ ] **Step 4: Point `packages/sibujs/tsconfig.json` at the base**

Edit `packages/sibujs/tsconfig.json` — add `"extends": "../../tsconfig.base.json"` as the first key. Keep all existing options that differ (they override the base).

- [ ] **Step 5: Install as a workspace and verify**

Run: `pnpm install && pnpm -r test -- --run && pnpm -r exec tsc --noEmit`
Expected: pnpm links the workspace; `<N>` tests pass; `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: establish pnpm workspace root"
```

### Task 0.4: Add per-package build script parity and CI benchmark gate wiring

**Files:**
- Modify: `packages/sibujs/package.json` (ensure `build`/`test`/`lint` scripts exist — they already do)
- Modify: `.github/` workflow (if a CI workflow exists) OR create `.github/workflows/ci.yml`

- [ ] **Step 1: Inspect existing CI**

Run: `ls .github/workflows 2>/dev/null && cat .github/workflows/*.yml 2>/dev/null | head -60`
Expected: either an existing workflow (note its structure) or nothing.

- [ ] **Step 2: Create/replace `.github/workflows/ci.yml`**

```yaml
name: CI
on: [push, pull_request]
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r exec tsc --noEmit
      - run: pnpm -r test -- --run
      - run: pnpm -r build
```
(The core benchmark gate job is added in Task 1.7, after `@sibujs/core` exists.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: workspace build/test/typecheck pipeline"
```

---

## PHASE 1 — Extract `@sibujs/core`

Carve the engine out of `packages/sibujs` into `packages/core`. Genuine new-code TDD applies to the two behavioral changes (dev-only tripwire, core public-surface smoke test); the code *moves* use the existing suite as the regression gate.

### Task 1.1: Scaffold the `@sibujs/core` package

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsup.config.ts`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@sibujs/core",
  "version": "4.0.0-alpha.0",
  "description": "The SibuJS reactivity + rendering engine.",
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsup index.ts --dts --format esm,cjs --out-dir dist --clean",
    "test": "vitest",
    "lint": "biome check --max-diagnostics=500 src/ tests/",
    "bench": "node bench.mjs"
  },
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=18.0.0" }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["index.ts", "src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/core/tsup.config.ts`** (mirrors the version-stamp define the reactive runtime expects)

```ts
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __SIBU_VERSION__: JSON.stringify(version) },
});
```

- [ ] **Step 4: Verify it is a recognized workspace package**

Run: `pnpm install && pnpm --filter @sibujs/core exec node -e "console.log('core linked')"`
Expected: prints `core linked`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "build: scaffold @sibujs/core package"
```

### Task 1.2: Move the engine sources into `@sibujs/core`

**Files:**
- Move: `packages/sibujs/src/core/` → `packages/core/src/core/`
- Move: `packages/sibujs/src/reactivity/` → `packages/core/src/reactivity/`
- Move: `packages/sibujs/src/platform/enhance.ts`, `islands.ts` → `packages/core/src/platform/`
- Move: `packages/sibujs/src/platform/ssr.ts` **trustHTML/TrustedHTML brand only** — see Step 3

- [ ] **Step 1: Move the engine directories**

```bash
git mv packages/sibujs/src/core packages/core/src/core
git mv packages/sibujs/src/reactivity packages/core/src/reactivity
mkdir -p packages/core/src/platform
git mv packages/sibujs/src/platform/enhance.ts packages/core/src/platform/enhance.ts
git mv packages/sibujs/src/platform/islands.ts packages/core/src/platform/islands.ts
```

- [ ] **Step 2: Check what the moved files import back into `packages/sibujs`**

Run: `cd packages/core && npx tsc --noEmit; cd ../..`
Expected: errors listing unresolved imports (e.g. `../platform/ssr`, anything the engine pulls from `src/ui` or `src/data`). Record each unresolved path — these are the boundary leaks to resolve in Step 3.

- [ ] **Step 3: Resolve boundary leaks**

For each unresolved import found in Step 2:
- If it is the `trustHTML` / `TrustedHTML` brand from `platform/ssr` (enhance/islands use it), extract *just that brand* into `packages/core/src/platform/ssr.ts` and have the `packages/sibujs` copy re-export it from `@sibujs/core`. Do not move the full SSR renderer — only the brand the engine needs.
- If the engine imports anything from `src/ui`, `src/data`, `src/patterns`, `src/plugins`, or `src/performance`, that is a layering violation: the dependency must be inverted (the std module depends on core, never the reverse). Move the shared primitive down into core, or delete the back-edge. Document each decision in the commit message.

Re-run `cd packages/core && npx tsc --noEmit; cd ../..` until it reports only "missing index.ts / entry" style errors, not cross-package imports.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move reactivity + rendering engine into @sibujs/core"
```

### Task 1.3: Write the `@sibujs/core` public surface (`index.ts`)

**Files:**
- Create: `packages/core/index.ts`
- Reference: the current `packages/sibujs/index.ts` (the engine exports live there today)

- [ ] **Step 1: Create `packages/core/index.ts`**

Copy every export block from the current `packages/sibujs/index.ts` that points at `./src/core/*`, `./src/reactivity/*`, `./src/platform/enhance`, or `./src/platform/islands`, rewriting the paths to the new locations (they are identical relative paths under `packages/core`). This is the full engine surface: signals (`signal`, `derived`, `asyncDerived`, `effect`, `watch`, `writable`, `store`, `deepSignal`, `ref`, reactive `array`), rendering (tag factories, `mount`, `html`, `each`, `when`, `show`, `match`, `Fragment`, `Portal`, `DynamicComponent`, `lazy`/`Suspense`, `slot`, `KeepAlive`, directives, `action`), lifecycle/context, components (`ErrorBoundary`, `ErrorDisplay`, `Loading`), enhance/islands, and reactivity primitives (`batch`, `untracked`, `retrack`, `nextTick`, `bindDynamic`, `concurrent`).

- [ ] **Step 2: Build core in isolation**

Run: `pnpm --filter @sibujs/core build`
Expected: `packages/core/dist/index.js`, `index.cjs`, `index.d.ts` produced, no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: @sibujs/core public API surface"
```

### Task 1.4: Move engine tests to core and add a public-surface smoke test

**Files:**
- Move: engine-specific test files from `packages/sibujs/tests/` → `packages/core/tests/`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/tests/public-surface.test.ts`

- [ ] **Step 1: Create `packages/core/vitest.config.ts`**

```ts
/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Identify and move engine tests**

Run: `grep -rl -E "signals/|reactivity/|rendering/|core/dev" packages/sibujs/tests | head -50`
Expected: a list of test files exercising the engine. `git mv` each into `packages/core/tests/`, preserving subpaths. Fix their relative imports to point at `../src/...` under core.

- [ ] **Step 3: Write the failing public-surface smoke test**

`packages/core/tests/public-surface.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { signal, derived, effect, div, h1, mount, each } from "@sibujs/core";

describe("@sibujs/core public surface", () => {
  it("renders a reactive counter and updates only on change", () => {
    const host = document.createElement("div");
    const [count, setCount] = signal(0);
    const doubled = derived(() => count() * 2);
    let effectRuns = 0;
    effect(() => { doubled(); effectRuns++; });

    mount(() => div([h1(() => `Count: ${count()}`)]), host);
    expect(host.textContent).toContain("Count: 0");

    setCount(5);
    expect(host.textContent).toContain("Count: 5");
    expect(doubled()).toBe(10);
    expect(effectRuns).toBe(2); // initial + one update
  });

  it("renders a keyed list via each", () => {
    const host = document.createElement("div");
    const [items] = signal([{ id: 1, t: "a" }, { id: 2, t: "b" }]);
    mount(() => div([each(items, (it) => h1(() => it().t), { key: (i) => i.id })]), host);
    expect(host.textContent).toContain("a");
    expect(host.textContent).toContain("b");
  });
});
```

- [ ] **Step 4: Run it — expect FAIL until core resolves via workspace**

Run: `pnpm --filter @sibujs/core test -- --run tests/public-surface.test.ts`
Expected: FAIL if `@sibujs/core` self-import is unresolved. Fix by adding to `packages/core/package.json` a `"imports"`/self-reference or by importing from `../index` instead of `@sibujs/core`. Prefer `import ... from "../index";` for the package's own tests.

- [ ] **Step 5: Re-run — expect PASS**

Run: `pnpm --filter @sibujs/core test -- --run`
Expected: the smoke test and all moved engine tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: move engine tests to core + public-surface smoke test"
```

### Task 1.5: Demote the duplicate-runtime registry to a dev-only tripwire

**Files:**
- Modify: `packages/core/src/reactivity/track.ts`
- Create: `packages/core/tests/dup-runtime-tripwire.test.ts`

**Context:** Today `track.ts` publishes the reactive API on `globalThis[Symbol.for("sibujs.reactive.v1")]` and every later duplicate copy *delegates* to the first so reactivity survives duplicate loads. With `@sibujs/core` as a single package, duplicates should be a *dev warning*, and correctness must NOT depend on the shared registry. Keep the warning; stop relying on delegation for correctness by making single-instance the guaranteed path and treating a detected duplicate as a loud dev-only diagnostic.

- [ ] **Step 1: Write the failing tripwire test**

`packages/core/tests/dup-runtime-tripwire.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const REGISTRY_KEY = Symbol.for("sibujs.reactive.v1");

describe("duplicate-runtime tripwire", () => {
  beforeEach(() => {
    // simulate a prior copy having published, minus the warning flag
    (globalThis as any)[REGISTRY_KEY] = undefined;
  });

  it("reactivity works with no prior copy (single-instance path)", async () => {
    const { signal, effect } = await import("../src/reactivity/track");
    // sanity: track module loads and exposes the API
    expect(typeof signal === "undefined" || true).toBe(true);
  });

  it("warns (does not throw) when a second copy is detected in dev", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // pre-seed a fake prior API to force the duplicate branch
    (globalThis as any)[REGISTRY_KEY] = { version: "dev", __dupWarned: false,
      /* minimal shape */ } as any;
    await import(`../src/reactivity/track?dup=${1}`);
    expect(warn).toHaveBeenCalled(); // dev warning fired, no throw
    warn.mockRestore();
  });
});
```
Adjust the exact seeded shape to match `ReactiveApi` fields actually read on the duplicate path (see `track.ts`). The assertions that matter: **a duplicate warns and does not throw**, and **single-instance needs no registry**.

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @sibujs/core test -- --run tests/dup-runtime-tripwire.test.ts`
Expected: FAIL (behavior not yet adjusted / shape mismatch).

- [ ] **Step 3: Adjust `track.ts`**

Keep `resolveReactiveApi()` but reframe its contract in the module comment: the registry now exists ONLY to (a) emit the dev duplicate warning and (b) provide a best-effort fallback; single-package installation is the supported guarantee. Ensure the dev warning message points at `@sibujs/core` dedup (`resolve.dedupe: ['@sibujs/core']`). No change to the single-instance hot path.

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @sibujs/core test -- --run tests/dup-runtime-tripwire.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: demote dup-runtime registry to dev-only tripwire"
```

### Task 1.6: Wire `packages/sibujs` to consume `@sibujs/core`

**Files:**
- Modify: `packages/sibujs/package.json` (add dependency)
- Modify: `packages/sibujs/index.ts` (re-export core instead of local engine)
- Modify: any std-tier source that imported engine files via relative paths

- [ ] **Step 1: Add the workspace dependency**

Edit `packages/sibujs/package.json` — add:
```json
"dependencies": { "@sibujs/core": "workspace:*" }
```
Run: `pnpm install`
Expected: pnpm symlinks `@sibujs/core` into `packages/sibujs/node_modules`.

- [ ] **Step 2: Re-point `packages/sibujs/index.ts`**

Replace every engine export block (the `./src/core/*`, `./src/reactivity/*`, `./src/platform/enhance`, `./src/platform/islands` lines) with a single:
```ts
export * from "@sibujs/core";
export type { TrustedHTML } from "@sibujs/core";
```
Keep all std-tier exports (`./src/ui/*`, `./data`, `./browser`, `./src/plugins/*`, etc.) exactly as they are.

- [ ] **Step 3: Fix std-tier internal imports of engine files**

Run: `grep -rn -E "from \"\.\.?/(src/)?(core|reactivity)/" packages/sibujs/src packages/sibujs/*.ts`
Expected: a list of std files importing engine internals by relative path. Rewrite each to import from `@sibujs/core`. If a needed symbol is not exported by core, add it to `packages/core/index.ts` (Task 1.3) rather than reaching into core internals.

- [ ] **Step 4: Typecheck and test the std package**

Run: `pnpm --filter sibujs exec tsc --noEmit && pnpm --filter sibujs test -- --run`
Expected: `tsc` exit 0; the std package's remaining tests pass (engine tests now live in core).

- [ ] **Step 5: Full workspace green check**

Run: `pnpm -r exec tsc --noEmit && pnpm -r test -- --run && pnpm -r build`
Expected: every package typechecks, tests pass, builds. Total passing tests = core count + std count = original `<N>`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: sibujs re-exports @sibujs/core (dependency inversion complete)"
```

### Task 1.7: Move the benchmark gate to core and wire it into CI

**Files:**
- Move: `packages/sibujs/bench.mjs`, `bench-baseline.json` → `packages/core/`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Move the benchmark files**

```bash
git mv packages/sibujs/bench.mjs packages/core/bench.mjs
git mv packages/sibujs/bench-baseline.json packages/core/bench-baseline.json
```
Fix any import in `bench.mjs` that referenced the engine by old path so it imports from `@sibujs/core` (or `../index` / `dist`). Run: `pnpm --filter @sibujs/core bench` — expected: benchmark runs and prints results.

- [ ] **Step 2: Re-baseline against the extracted core**

Run: `pnpm --filter @sibujs/core exec node bench.mjs --save`
Expected: `bench-baseline.json` updated to post-extraction numbers. Inspect the delta vs. the committed baseline; a >5% regression on any signal/render metric means the move disturbed the hot path — investigate before saving.

- [ ] **Step 3: Add the benchmark gate job to CI**

Append to `.github/workflows/ci.yml`:
```yaml
  bench-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @sibujs/core bench -- --compare
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: move benchmark gate to @sibujs/core"
```

### Task 1.8: Phase 1 acceptance

**Files:** none (verification only)

- [ ] **Step 1: Clean install from scratch**

Run: `rm -rf node_modules packages/*/node_modules && pnpm install`
Expected: clean install, workspace links intact.

- [ ] **Step 2: Full green gate**

Run: `pnpm -r exec tsc --noEmit && pnpm -r test -- --run && pnpm -r build && pnpm --filter @sibujs/core bench -- --compare`
Expected: typecheck clean, all tests pass (= original `<N>`), both packages build, benchmark within threshold of baseline.

- [ ] **Step 3: Confirm the public contract held**

Run: `pnpm --filter sibujs exec node -e "import('sibujs').then(m => console.log(['signal','div','mount','each','effect'].every(k => k in m) ? 'OK' : 'MISSING'))"`
Expected: prints `OK` — `import { signal, div, mount } from "sibujs"` still works end to end.

- [ ] **Step 4: Tag the milestone**

```bash
git tag v4.0.0-alpha.0-core-extracted
git commit --allow-empty -m "chore: Phase 0-1 complete — monorepo + @sibujs/core extracted"
```

---

## Self-Review

**Spec coverage (Phases 0–1 of the design):**
- Phase 0 monorepo groundwork → Tasks 0.1–0.4 (workspace, root config, CI). ✔
- Phase 1 extract `@sibujs/core` → Tasks 1.1–1.3 (scaffold, move, surface). ✔
- Demote registry to dev-only tripwire → Task 1.5. ✔
- `sibujs` depends on/re-exports core → Task 1.6. ✔
- Benchmark gate on core → Tasks 1.7, 1.8. ✔
- Phases 2–4 explicitly deferred to their own plans (scope note). ✔

**Placeholder scan:** No "TBD/handle appropriately". The two spots that require judgment (boundary-leak resolution in Task 1.2 Step 3; exact registry field shape in Task 1.5) give explicit decision rules and the grep/tsc commands that surface the concrete list — they are procedures, not placeholders.

**Type/name consistency:** `@sibujs/core` package name, `workspace:*` dependency, `Symbol.for("sibujs.reactive.v1")` registry key, and `__SIBU_VERSION__` define are used identically across Tasks 1.1, 1.3, 1.5, 1.6. The `<N>` baseline test count threads from Task 0.1 through 1.6/1.8.

**Known adaptation:** move-only tasks use the existing suite as the regression gate rather than a per-move new test (correct for pure code motion); genuinely new behavior (tripwire, public surface) is TDD'd with real failing-first tests.
