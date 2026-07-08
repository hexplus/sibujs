# Migrating to SibuJS v4

v4 splits the single `sibujs` package into three:

- **`@sibujs/core`** — the reactivity + rendering engine.
- **`sibujs`** — batteries-included; re-exports `@sibujs/core` plus the router,
  i18n, SSR, data, and UI layers.
- **`@sibujs/labs`** — opt-in long-tail modules (lower support guarantee).

The goals: make bundler de-duplication a packaging guarantee (one engine copy),
and keep the maintained first-party surface small.

## What did NOT change

Root imports from `sibujs` are unchanged — the engine is re-exported:

```javascript
// Works in v3 and v4
import { signal, effect, div, mount, each, when, Portal } from "sibujs";
```

These `sibujs/*` subpaths are unchanged: `sibujs/data`, `sibujs/ui`,
`sibujs/plugins`, `sibujs/ssr`, `sibujs/build`, `sibujs/testing`, `sibujs/cdn`.

## Breaking changes

### 1. Long-tail subpaths moved to `@sibujs/labs`

Install it: `npm install @sibujs/labs`, then update imports:

| v3 | v4 |
| --- | --- |
| `sibujs/browser` | `@sibujs/labs/browser` |
| `sibujs/widgets` | `@sibujs/labs/widgets` |
| `sibujs/patterns` | `@sibujs/labs/patterns` |
| `sibujs/motion` | `@sibujs/labs/motion` |
| `sibujs/ecosystem` | `@sibujs/labs/ecosystem` |
| `sibujs/performance` | `@sibujs/labs/performance` |
| `sibujs/devtools` | `@sibujs/labs/devtools` |
| `sibujs/extras` | `@sibujs/labs` (aggregate) |

### 2. Component patterns left `sibujs/ui`

`composable`, `hoc`, `componentProps`, and `contracts` are now in
`@sibujs/labs/patterns` (they were re-exported from `sibujs/ui` in v3).

```diff
- import { composable, hoc } from "sibujs/ui";
+ import { composable, hoc } from "@sibujs/labs/patterns";
```

### 3. `sibujs/extras` removed

It aggregated every advanced module. Import from the specific `@sibujs/labs`
subpath instead, or use the `@sibujs/labs` aggregate.

## Mechanical migration

Most changes are prefix rewrites. For example, with a codemod or find-and-replace:

```
sibujs/browser      -> @sibujs/labs/browser
sibujs/widgets      -> @sibujs/labs/widgets
sibujs/patterns     -> @sibujs/labs/patterns
sibujs/motion       -> @sibujs/labs/motion
sibujs/ecosystem    -> @sibujs/labs/ecosystem
sibujs/performance  -> @sibujs/labs/performance
sibujs/devtools     -> @sibujs/labs/devtools
```

## Bundler de-duplication

If a warning about "multiple instances of the reactive runtime" appears, ensure a
single `@sibujs/core` resolves (e.g. Vite `resolve.dedupe: ['@sibujs/core']`).
`sibujs` and `@sibujs/labs` both keep `@sibujs/core` external, so a correct
install ships exactly one engine copy.

## `each()` render getters

The `item`/`index` getters passed to an `each()` render callback are now typed as
`StaticGetter<T>`. Behaviour is unchanged from v3 — they read fresh but do **not**
subscribe. The type just makes the contract explicit; drive reactive per-row
content from a per-item `signal`/`store`, not from `item()`.
