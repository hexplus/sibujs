# SibuJS — Improvement Plan

Status tracker for improvements detected during the core integrity, performance,
coverage, and OWASP security audits, plus the duplicate-instance hardening (§8).
Discrete items (§2–§8) are **applied**; §1 (drive coverage to 100%) is an
ongoing multi-turn effort.

Priority key: **P1** = do next · **P2** = soon · **P3** = nice-to-have.
Effort key: **S** ≤1h · **M** half-day · **L** multi-day.

---

## 1. Test coverage — finish the last mile  ·  🔄 ONGOING

Overall ~98.4% statements. **`core/`, `reactivity/`, `browser/`, `utils/` are at
100%.** Remaining gap is the feature/integration directories.

| Item | Dir | Coverage | Priority | Effort |
|---|---|---|---|---|
| Cover `patterns/` (persist, machine remainder) — machine/composable/contracts/timeline/optimistic ✅ | `src/patterns` | 97.9% | P1 | S |
| Cover `ui/` (form, formAction, stream, socket, virtualList, springSignal, inputMask) — hover/reducedMotion/reactiveAttr/toast/dialog/scopedStyle ✅ | `src/ui` | 96.0% | P1 | M |
| Cover `plugins/` (router branches, ecosystem, versioning, routerSSR) | `src/plugins` | 96.2% | P1 | M |
| Cover `data/` (query, infiniteQuery, offlineStore) | `src/data` | 97.0% | P2 | M |
| Cover `platform/` (ssr, microfrontend, head, serviceWorker, scrollRestoration) | `src/platform` | 97.9% | P2 | M |
| Cover `devtools/`, `build/`, `testing/`, `widgets/`, `components/` (1–3 lines each) | various | 98–99% | P2 | S–M |

Established approach: handler/dispose tests, `vi.stubGlobal` for environment
fallbacks, the production-mode pass in `tests/prod-mode.test.ts` for
dev/prod-gated branches, and justified `/* v8 ignore */` for genuinely
unreachable defensive code. Remaining gaps are mostly single-branch edges
(env fallbacks, attribute-restore paths, IndexedDB key paths).

---

## 2. Code cleanup  ·  ✅ APPLIED

- Deleted the empty deprecation stubs `src/core/signals/memo.ts`,
  `src/core/signals/memoFn.ts`, `src/patterns/primitives.ts` and removed their
  entries from the `coverage.exclude` list in `vitest.config.ts`. Verified no
  imports referenced them; build + suite green.

---

## 3. Reactivity core  ·  ✅ APPLIED (documented)

- **Effect notification order (LIFO)** — documented in `reactivity/track.ts`
  (`linkSignal`): sibling effects/bindings fire most-recently-subscribed-first
  as an intentional consequence of O(1) head insertion; correctness does not
  depend on order (glitch-free + converges), but callers must not rely on
  declaration order between sibling effects.
- **Deep-chain recompute is recursive** — already documented in `derived.ts`
  (dirty marking is iterative; pull-evaluation is O(depth) frames). Left as-is:
  making pull-based recompute iterative with dynamic deps is high-risk for the
  perf-critical core and the practical threshold is in the thousands. (P3/L —
  revisit only if deep derived graphs become a supported use case.)

---

## 4. Performance  ·  ✅ APPLIED

- Fixed the list benchmark's render callback in `bench.mjs`
  (`(item) => li({ nodes: [() => item().label] })`) so each `<li>` renders real
  content and the per-row item-getter path is exercised.
- **Benchmark harness made trustworthy** — the `Create 10,000 effects` bench was
  a single un-warmed `iterations: 1` shot that swung ~10→20 ms run to run. It now
  measures create-only cost (disposal outside the timed region), warmed (3 rounds
  discarded) and averaged over 12 rounds on fresh throwaway signals (~14% spread,
  under the 20% gate). `bench-baseline.json` was regenerated, so `bench:check`
  reports no false regressions. (Re-run `npm run bench:save` on the reference
  machine / CI to set canonical numbers — the baseline is machine-specific.)
- `each` per-row closure pooling — **deferred** (P3): create-only and
  render-dominated; revisit only if list-create profiling flags it.

Already shipped earlier this cycle: `sanitizeCSSValue` fast-path (7.4×),
`tagFactory` blocked-tag precompute (4.2×), per-notification closure removal in
`watch`/`store`.

---

## 5. Security hardening (defense-in-depth)  ·  ✅ APPLIED

- Routed resource-hint hrefs through `sanitizeUrl` and refused dangerous
  schemes: `preloadModule` (`chunkLoader.ts`), `preloadResource` + `prefetch`
  (`domRecycler.ts`). `preloadModule`'s dedup selector now escapes the
  sanitized URL (CSS-selector injection, CWE-74).
- **`favicon()` intentionally excluded** — it legitimately serves
  `data:image/svg+xml` URIs (via `svgFavicon`), which `sanitizeUrl` would block,
  and `javascript:` cannot execute on `<link rel=icon>`.
- Hardened testing-helper selectors with an `escSel()` quote/backslash escape
  in `testing/adapters.ts` (5 selectors, `#id` → `[id="…"]`) and
  `testing/a11y.ts` (the DOM-derived `label[for]` lookup). `[role=…]` selectors
  fed by hardcoded constants left as-is.
- Added the regression cases to `tests/security-audit.test.ts` (now 33 cases).

---

## 6. Developer-experience footguns  ·  ✅ APPLIED (documented)

- Documented the `when`/`match` eager-branch-read gotcha in the JSDoc of both
  directives (`core/rendering/directives.ts`) and added a "Common mistakes" row
  to the `sibujs-web` AGENTS.md (public + dist copies).

---

## 7. Shipped earlier this cycle (context)

- **Correctness:** `watch`/`store.subscribe`/`store.subscribeKey` callbacks run
  untracked (no dependency leaks); reactive `srcset` uses per-candidate
  validation via the shared `sanitizeAttributeString`.
- **Performance:** `sanitizeCSSValue` fast-path, `tagFactory` blocked-tag
  precompute, per-notification closure removal in `watch`/`store`.
- **Security:** CSS-selector-injection fix in `preloadModule` (CWE-74);
  `tests/security-audit.test.ts` (OWASP-mapped).
- **Coverage:** `core/`, `reactivity/`, `browser/`, `utils/` to 100%;
  production-mode coverage harness + barrel-export tests; coverage config
  hygiene.
- **Docs:** `sibujs-web` AGENTS.md `base.css` import instruction + corrected
  theme list.

---

## 8. Duplicate-instance resilience (3.3.1–3.3.2)  ·  ✅ APPLIED

SibuJS's coordination singletons silently broke when a bundler materialized a
module more than once on a page (Vite `optimizeDeps` / esbuild dependency
pre-bundling serves the same chunk twice — once with `?v=<hash>`, once raw).
Each copy kept its own module state, so cross-copy interactions (a `signal()`
write vs. a binding that tracked through the other copy) never connected and
reactivity died with no error. Fixed by routing every duplicate copy through the
**first one loaded**, keyed by versioned `Symbol.for` keys on `globalThis`.

- **Reactive core (`reactive.v1`)** — split into `src/reactivity/track-core.ts`
  (implementations + module-local state) and a `src/reactivity/track.ts` facade
  that, on first load, publishes the impls and on every later load **re-exports
  the first copy's functions**. Only one copy's code runs (plain module-local
  state, byte-identical to a single-instance build), so there is **no hot-path
  indirection** — an earlier state-sharing attempt regressed effect/binding
  creation ~70%; function-sharing avoids it (verified by interleaved cold+warm
  benchmarks).
- **Singletons swept** (same first-copy-wins pattern):
  - `batch` (`reactive.batch.v1`) — `batchDepth` / `pendingSignals`.
  - `createId` (`createId.v1`) — the id counter, so duplicate copies can't both
    emit `sibu-1` (broke a11y pairing / SSR hydration).
  - `ssr-context` (`ssr.v1`) — the AsyncLocalStorage instance + fallback store,
    so `enableSSR()` in one copy is seen by `isSSR()` in another.
  - `router` `globalRouter` (`router.v1`) — navigation / `Outlet` / `Link` in a
    duplicated `plugins` chunk see the router `createRouter()` made.
  - action registry (`actions.v1`) — `registerAction`/`getAction` lookups.
  - Audited and already safe: `context()` (instance-owned signal), the devtools
    hook (`__SIBU_DEVTOOLS_GLOBAL_HOOK__` on `globalThis`).
- **Dev warning** — loading a second copy logs a one-time, actionable warning
  (de-dupe via `optimizeDeps.exclude` / `resolve.dedupe`), version-stamped via a
  `__SIBU_VERSION__` build define added in `tsup.config.ts`. Dev-only; strippable.
- **Tests** — `tests/duplicate-instance.test.ts` evaluates the bundled core twice
  to prove cross-instance reactivity / batching / id / SSR sharing and the
  once-only warning; `tests/duplicate-instance-source.test.ts` covers the
  source-module duplicate-detection branch (pre-seed the registry, re-import) so
  `track.ts`/`batch.ts` stay at 100%.
- **Packaging (deferred)** — the published `dist/` is ~30 small, circularly
  dependent `chunk-*.js` files (normal multi-entry tsup output), which is what
  makes optimizers clone the core. Consolidating the core into one non-circular
  chunk was assessed and **deferred**: function-sharing already makes duplication
  non-breaking, so a build restructure is real regression risk (tree-shaking /
  entry points) for marginal benefit. Revisit only if bundle-size profiling
  flags the duplicated core in a real app.
