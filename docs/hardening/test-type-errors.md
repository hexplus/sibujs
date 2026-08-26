# Test-suite TypeScript errors — categorisation and disposition

**Before: 130 errors across 39 files. After: 0.**

`tsconfig.json` includes only `["src", "index.ts"]`, so the test suite and 14 of
the 16 subpath entry files had never been type-checked. Vitest strips types
rather than checking them, so a test could call a public API in a way the
published types forbid and still go green.

Errors were categorised **before** any were fixed, because the distribution is
the useful signal: 34 of the 130 turned out to be a single framework declaration
bug, not 34 sloppy tests.

## Disposition by category

| Category | Errors | Fixed in | Notes |
|---|---:|---|---|
| Framework declaration bug | **41** | `src/` | Public types rejected valid, idiomatic usage |
| Test-helper typing | 30 | `tests/` | Over-narrow helper signatures, untyped mock captures |
| API misuse in tests | 22 | `tests/` | Tests calling APIs the types have always forbidden |
| Insufficient narrowing | 21 | `tests/` | Unions / `unknown` read without narrowing |
| Deferred-promise plumbing | 3 | `tests/` | "used before being assigned" |
| Intentional invalid input | 3 | `tests/` | Now `@ts-expect-error` with a reason |
| Genuine test bug | 1 | `tests/` | A test that was silently vacuous |
| Stale suppression | 1 | `tests/` | `@ts-expect-error` that no longer suppressed anything |
| **Total** | **130** | | |

The split matters: **41 were the framework's fault, 89 were the tests'.** An
approach that assumed "the tests are wrong" would have papered over five real
declaration defects.

## Framework declaration bugs (41 errors, 5 defects)

Each was confirmed with a consumer-style type test in
`tests/types/public-api-contract.test.ts` before any declaration changed.

### TYPE-001 — `interface` rejected by `Record<string, unknown>` constraints (34 errors)

`eventBus<T extends Record<string, unknown>>` and the `normalize` family
rejected an event map or entity declared as an `interface`:

```ts
interface AppEvents { message: string }
const bus = eventBus<AppEvents>();
//                   ^ Type 'AppEvents' does not satisfy 'Record<string, unknown>'
```

An `interface` has no implicit index signature; a `type` alias does. So the
identical shape compiled or failed depending on which keyword declared it, while
the runtime handled both perfectly.

Fixed by widening to `T extends object`. `eventBus` only ever uses `keyof T` and
`T[K]`, so nothing needed the index signature. `normalize` does index entities
with a runtime `idKey` string — but the old constraint never made that sound
either (an arbitrary `idKey` was unchecked regardless), it only excluded valid
callers. The indexing now goes through one documented internal cast.

### TYPE-002 — remaining `Record<string, unknown>` constraint sites (0 errors, open)

The same pattern appears at roughly 20 further public generics (`machine`,
`wasm`, `defineComponent`, `createSharedScope`, `offlineStore`, and others).
**Not changed**: no test exercises them, and changing a public constraint
without a reproducing case is speculative. Recorded so the pattern is known
rather than silently accepted.

### TYPE-003 — `RouterLink` declared `HTMLElement` (8 errors)

`RouterLink` always builds an `<a>`, but was declared to return `HTMLElement`,
so reading back the very props it sets did not type-check:

```ts
const link = RouterLink({ to: "/x", target: "_blank" });
link.target;  // Property 'target' does not exist on type 'HTMLElement'
```

Fixed by returning `HTMLAnchorElement`. Widening a return type is
backwards-compatible.

### TYPE-007 — `globalStore` action payloads (3 errors)

The action-map constraint `(state: S, payload?: unknown) => Partial<S>` looks
permissive but is the opposite: it requires every action to **accept** any
`unknown`, so a typed action is not assignable —

```ts
actions: { add: (state, amount: number) => ({ count: state.count + amount }) }
```

— and `Parameters<A[K]>[1]`, which `dispatch` already used to type its payload,
collapsed to `unknown` for every action. The constraint defeated the per-action
payload typing the rest of the file is built around.

Fixed with an exported `StoreActionMap<S>` using a `never[]` rest parameter,
which accepts any concrete signature while keeping `Parameters<A[K]>` intact.

### TYPE-009 / TYPE-010 — declaration gaps left open (deliberately)

Two further mismatches were confirmed but **not** changed, because fixing them
means changing the public API during a freeze:

- **TYPE-009** — `action(el, copyOnClick)` does not compile. `copyOnClick` is
  `ActionFn<(() => string) | undefined>` (its text getter is optional), but the
  two-argument `action()` overload requires `ActionFn<void>`, so a first-party
  action with an optional param cannot be applied without one. Recommend an
  additive overload accepting `ActionFn<T | undefined>`.
- **TYPE-010** — `bindField()` documents itself as returning props "ready to
  pass directly to a tag factory", but `BoundFieldProps.value: () => unknown`
  does not satisfy the typed factories' `reactive<string>`. Recommend making
  `bindField` generic over the field's value type.

Both call sites carry a documented cast and a pointer to this file.

Left open on the same reasoning: **TYPE-006** — `generateEslintConfig()` returns
`Record<string, unknown>`, making every property read `unknown`. That lives in
`src/build/`, which is off-limits without sign-off, so the test narrows through
a declared `EslintConfigShape` interface instead.

## Test-side fixes worth calling out

### TYPE-008 — a test that was silently vacuous

Type-checking caught a real bug that had been passing for as long as it existed:

```ts
const [s, { setState }] = store({ count: 0 });
const teardown = effect(() => spy(store.count));   // `store`, not `s`
```

`store` is the imported **factory function**; `store.count` is `undefined` and,
critically, the effect subscribed to **nothing**. The test then asserted
"subscriber dead" after teardown — which held trivially, because the subscriber
was never alive. Fixed to `s.count`; the test now exercises the disposal it
names.

### Vacuity-proof mock captures

Thirteen "This expression is not callable" errors came from the same shape: a
callback captured from a mocked global.

```ts
let rafCb: FrameRequestCallback | null = null;
vi.stubGlobal("requestAnimationFrame", (cb) => { rafCb = cb; return 1; });
rafCb?.(0);
```

TypeScript narrows `rafCb` to `null` at the use site because the only assignment
is inside a closure it cannot prove ran. The usual patch — `rafCb?.(0)` —
compiles but **silently does nothing if the mock never fired**, so the test
passes while exercising none of the code it names.

Replaced with `callbackSlot<F>()` in `tests/helpers/mocks.ts`, whose `invoke()`
throws when nothing was captured. All migrated tests still pass, so those mocks
were genuinely firing — and now they cannot stop firing unnoticed.

### Typed deferreds

Three "used before being assigned" errors were hand-rolled deferred promises.
Replaced with `createDeferred<T>()` from the same helper module, which types
`resolve` / `reject` correctly instead of relying on a non-null assertion or an
`any` that discards the payload type.

### Narrowing instead of optional chaining

Several tests read a discriminated union or a regex match through `?.`:

```ts
expect(result?.type).toBe("duplicated");           // NavigationResult
const json = script.match(/.../)?.[1].replace(...); // string | undefined
```

Both compile and both hide a failure mode — `undefined` silently satisfies the
first, and flows into `JSON.parse` in the second. Replaced with real narrowing
that throws a descriptive error, so a shape change fails loudly.

## Suppression policy after this pass

| Metric | Count |
|---|---:|
| `@ts-ignore` in `tests/` | **0** (enforced by Biome's `noTsIgnore`) |
| `@ts-expect-error` in `tests/` | 13, every one with a stated reason |
| `as any` in `tests/` | 43 — all pre-existing, classified below |

`@ts-expect-error` is preferred throughout because it **fails when the error
stops occurring**, so a constraint that is later relaxed cannot leave a stale
suppression behind. One such stale directive was found and removed in this pass.

### `as any` classification

None of these hide a compile error — the suite is at zero — but they are
recorded rather than removed wholesale:

| Kind | Approx. count | Verdict |
|---|---:|---|
| Stubbing untyped globals (devtools hooks, `scrollTo`) | ~20 | Necessary escape hatch |
| Probing internal fields (`__name`, `__signal`, `_event`) | ~17 | Necessary — those tests target internals |
| Deliberately invalid input (invalid routes, unknown store keys, string event handlers) | 15 | Legitimate, though `@ts-expect-error` would be stricter |
| Third-party config objects (webpack) | 1 | Necessary |

The deliberately-invalid group is the one worth converting to
`@ts-expect-error` later. It was left alone here because rewriting 15 assertion
sites during a freeze is churn with regression risk and no evidence behind it.

## What zero errors does and does not prove

It proves **the committed tests use SibuJS the way its published types permit**.
Runtime tests and TypeScript contracts now agree on what valid usage means,
which is the precondition for a test to be evidence about the public API at all.

It does **not** prove the public types are correct or complete. Three known
declaration gaps (TYPE-006, TYPE-009, TYPE-010) remain open by choice, and
TYPE-002 covers a pattern that likely affects around 20 more generics with no
test coverage to confirm it.
