# SibuJS v4 — Architecture De-risking Design

**Date:** 2026-07-08
**Status:** Approved (design phase)
**Branch:** `feature/split-core`

## Purpose

Nullify three architectural risks identified in a review of the SibuJS core:

1. **Scope / surface area** — one package with 15 subpath entry points spanning a
   reactive core, router, i18n, SSR, islands, 33 browser-API wrappers, widgets,
   motion, state machines, build plugins, devtools, and ecosystem adapters. The
   *core* is excellent; the *perimeter* exceeds the maintenance capacity behind it.
2. **Runtime dedup as a symptom** — the `globalThis`-registry facade in
   `track.ts` funnels duplicate module copies through the first-loaded
   `track-core` to keep reactivity alive under bundler pre-bundling. It works, but
   needing *runtime* dedup is a sign the single-mega-package model fights the
   bundler ecosystem. Dedup should be a *packaging* guarantee.
3. **Sharp edges in the reactive model** — footguns the type system cannot catch:
   `each()`'s `item()`/`index()` getters intentionally do not subscribe (per-row
   reactivity requires per-item signals), and the lone-string authoring rule
   (`div("space-y-6")` is a text child, not a class list).

These are addressed under a **v4 major version** with freedom to break, and a
migration guide for consumers.

## Non-Goals

- No rewrite of the reactivity engine. It is sound and benchmark-tuned; it moves,
  it does not change semantics.
- No change to `each()`'s reactivity model (see Phase 3 decision).
- No full per-domain monorepo (~12 packages) — rejected; see Topology.
- No unrelated refactoring outside the three risks.

## Target Topology — Three Tiers

Rejected the full per-domain monorepo: it fixes dedup and scope structurally but
re-creates scope sprawl as ~12 package.jsons, changelogs, and release pipelines —
the same disease in a tidier hat. Three tiers target the root cause (perimeter vs.
capacity) with minimal packaging tax:

| Package | Contents | Contract |
| --- | --- | --- |
| `@sibujs/core` | Reactivity (`signal`, `derived`, `effect`, `watch`, `batch`, `store`, …), rendering (tag factories, `mount`, control flow, directives), components, lifecycle, context, enhance/islands primitives. | Standalone. Semver-strict. Benchmark-gated. Dedup guaranteed by being one package. |
| `sibujs` | **Std tier.** Keeps the install name. Router, i18n, SSR, data, core UI. Depends on and re-exports `@sibujs/core` so `npm i sibujs` still gives batteries. | First-party, supported. Deliberately small bar. |
| `@sibujs/labs` | Long tail: browser-API wrappers, widgets, motion, patterns, ecosystem adapters, speculative build extras. | Opt-in. Explicitly **lower** support contract. Staging area — items earn promotion to std or age out. |

`npm i sibujs` remains the batteries-included entry point. Tiering makes the
"first-party vs. things I built because I could" decision *structural* instead of
aspirational, at a cost of 3 packages, not 12.

## Phased Plan (dependency-ordered)

### Phase 0 — Monorepo groundwork (enabler, no public change)
- Convert repo to **pnpm workspaces**.
- Shared build (tsup), test (vitest), lint (biome), and release tooling hoisted.
- Root `package.json` with workspace globs; per-package `package.json` scaffolds.
- CI runs all package test suites + the core benchmark gate.

### Phase 1 — Extract `@sibujs/core` (Risk 2)
- Move `src/core/**`, `src/reactivity/**`, and the enhance/islands primitives into
  `@sibujs/core`.
- **Demote the multi-instance registry** (`track.ts` `globalThis` facade) from
  correctness-critical to a **dev-only tripwire**: with a single core package +
  peer/dedup, duplicate copies become a version-mismatch/bundler-config problem
  the dev warning surfaces, not a silent-death path the runtime must survive.
- `sibujs` and `@sibujs/labs` declare `@sibujs/core` as a dependency (and
  `peerDependency` where they are libraries meant to share a consumer's core).
- Everything downstream depends on this, so it lands first.

### Phase 2 — Tier the surface (Risk 1)
- Write a **first-party bar**: real usage, test coverage, uniqueness (does it earn
  its place vs. userland), and maintenance cost.
- Audit all 15 current subpaths against it. Outcome per subpath: **keep in `sibujs`
  (std)**, **move to `@sibujs/labs`**, or **delete** (genuinely speculative/unused).
- Provisional split (to be confirmed during audit):
  - **std (`sibujs`):** `plugins` (router/i18n), `ssr`, `data`, `ui` essentials,
    `build`, `testing`.
  - **labs (`@sibujs/labs`):** `browser` (33 wrappers), `widgets`, `motion`,
    `patterns`, `ecosystem`, `performance` extras, `devtools` overlay.
- Define the **promotion/demotion contract** between labs and std.

### Phase 3 — Harden the sharp edges (Risk 3)
- **`each()` decision: keep current behavior** (`item()`/`index()` stay
  non-subscribing — the correct fine-grained-perf choice). Guard it instead of
  changing it:
  - Tighten types/docs so the non-reactive contract is explicit at the call site.
  - Add a **`sibujs-eslint-plugin` rule** flagging patterns that assume `item()`
    is reactive.
  - Keep/strengthen the dev warning path.
- **Lone-string ambiguity:** promote the existing dev warning to a first-class
  **lint rule** in `sibujs-eslint-plugin` (flag lone strings that look like class
  lists), plus doc emphasis. No runtime behavior change.
- Lands last, on stable structure.

### Phase 4 — v4 release
- **Migration guide** for the import-path moves (mechanical).
- **Codemod** for `sibujs/<subpath>` → `@sibujs/labs/<subpath>` rewrites where
  paths moved (very codemod-able; the moves are mechanical import rewrites).
- Changelog per package (each package's changelog describes only that package).

## Interfaces & Boundaries

- **`@sibujs/core`** exposes the current root `index.ts` surface, minus anything
  reclassified as std/labs. Public API of the engine is unchanged in *shape*.
- **`sibujs`** re-exports `@sibujs/core`'s root plus its own std subpaths, so
  existing `import { signal, div, mount } from "sibujs"` keeps working.
- **`@sibujs/labs`** mirrors today's subpath names (`@sibujs/labs/browser`,
  `@sibujs/labs/widgets`, …) so migration is a prefix change.

## Testing Strategy

- Each package keeps/gets its own vitest suite; no cross-package test reach-in.
- `@sibujs/core` gains a **benchmark gate** in CI using the existing `bench.mjs`
  and `bench-baseline.json` — a Phase-1 regression must fail the build.
- Playwright browser tests continue at the integration layer against `sibujs`.
- A dedicated test asserts the **dev-only tripwire** fires on a simulated
  duplicate-core load and that reactivity no longer depends on it for correctness.
- Lint rules added in Phase 3 ship with their own fixture tests in
  `sibujs-eslint-plugin`.

## Error Handling & Compatibility

- Dev builds warn (not throw) on duplicate `@sibujs/core`, with bundler-dedup
  guidance.
- v4 is a clean break for import *paths*; runtime APIs keep their shapes so most
  migration is codemod-driven prefix rewrites.
- Deprecated/removed subpaths are listed explicitly in the migration guide.

## Risks & Mitigations of This Plan

- **pnpm workspace migration churn** → Phase 0 is isolated and produces no public
  change; validated by the full suite passing before Phase 1.
- **labs becoming a graveyard** → the promotion/demotion contract + lower support
  bar make labs a staging area with a forcing function, not a dumping ground.
- **Consumer breakage from path moves** → codemod + migration guide; std keeps the
  common imports working under the `sibujs` name.

## Open Questions

- Exact std-vs-labs assignment per subpath — resolved during the Phase 2 audit
  against the first-party bar, not pre-committed here beyond the provisional split.
