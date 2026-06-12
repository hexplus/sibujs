# SibuJS — Improvement Plan

Status tracker for improvements detected during the core integrity, performance,
coverage, and OWASP security audits. Discrete items (§2–§6) are **applied**;
§1 (drive coverage to 100%) is an ongoing multi-turn effort.

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
  content and the per-row item-getter path is exercised. NOTE: re-run
  `npm run bench:save` to refresh `bench-baseline.json` (the values shifted).
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
