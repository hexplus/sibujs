# Stable-release preflight — baseline

Recorded **before** any change in this pass. Two gaps were open after RC
certification, and this document pins their starting state so the "after"
numbers mean something.

## Environment

| Item | Value |
|---|---|
| Commit at start | `943b031` — `fix(router,query): DOM-less bootstrap, unref'd cache GC, dropped async component` |
| Package version | `sibujs@3.4.1` |
| Node (host) | v24.19.0 |
| npm (host) | 11.17.0 |
| TypeScript | 5.9.3 |
| OS | Windows 11 (win32 10.0.26200, x64) |

## Declared support vs. what CI executed

| Claim | Declared in | Actually executed |
|---|---|---|
| `engines.node` | `>=18.0.0` | **Node 20 only** |
| CI matrix | `.github/workflows/ci.yml` | single job, `node-version: 20` |
| Publish workflow | `.github/workflows/publish.yml` | `node-version: "22"` |

The gap this pass exists to close: `>=18.0.0` covers four release lines
(18, 20, 22, 24) and CI exercised exactly one of them. Node 18 and 22 users
were, in effect, the compatibility testers. RC-002 — a Node-only event-loop bug
invisible to a green jsdom suite — is the evidence that this matters.

CI also ran **no typecheck at all**: `npm install`, `lint`, `build`, `test`.
Neither `tsc --noEmit` nor any test typecheck was a gate.

## Test-suite TypeScript

| Metric | Value |
|---|---|
| `tsc --noEmit` (source, `tsconfig.json`) | **clean** |
| `tsc -p tsconfig.test.json` (tests + entry files) | **130 errors across 39 files** |
| Test files | 361 |
| Tests | 4 373 passing, 1 skipped |

`tsconfig.json` has `"include": ["src", "index.ts"]`, so neither `tests/` nor the
other 14 subpath entry files had ever been type-checked. `tsconfig.test.json`
was added during RC certification purely to *measure* the problem; nothing was
fixed then.

### Baseline error distribution by TypeScript code

| Code | Count | Meaning |
|---|---|---|
| TS2344 | 36 | generic constraint not satisfied |
| TS2345 | 32 | argument not assignable |
| TS2339 | 20 | property does not exist |
| TS2349 | 13 | expression is not callable |
| TS2571 | 6 | object is of type `unknown` |
| TS18046 | 5 | value is of type `unknown` |
| TS2769 | 4 | no overload matches |
| TS2352 | 4 | unsafe conversion |
| TS2322 | 4 | type not assignable |
| TS2454 | 3 | used before being assigned |
| TS2578 | 1 | unused `@ts-expect-error` |
| TS2493 | 1 | tuple index out of range |
| TS18047 | 1 | possibly `null` |

### Baseline concentration by file

Seven files held 77 of the 130 errors:

| File | Errors |
|---|---|
| `normalize.test.ts` | 18 |
| `eventBus.test.ts` | 17 |
| `errorBoundary.working.test.ts` | 12 |
| `router.coverage.test.ts` | 8 |
| `linting.test.ts` | 8 |
| `compiled.test.ts` | 8 |
| `createEventBus.test.ts` | 6 |

## Build and RC status at baseline

| Gate | Status |
|---|---|
| `npm run build` | PASS |
| `npm run lint` | PASS |
| Full suite | PASS — 4 373 / 361 files |
| RC certification (`npm run certify:rc`) | ALL REQUIRED GATES PASSED |
| RC classification | PRODUCTION-HARDENED CANDIDATE — BEGIN REAL-WORLD VALIDATION |
| Open P0 / P1 | none |

## Commands used

```bash
# baseline measurements
node -e "console.log(JSON.stringify(require('./package.json').engines))"
npx tsc --noEmit
npx tsc -p tsconfig.test.json                 # 130 errors
npx vitest run --reporter=dot
npm run build
grep -rn "node-version" .github/workflows/

# this pass
npm run typecheck            # source
npm run typecheck:tests      # tests + all 16 entry files
node scripts/certify/node-matrix.mjs          # Node 18/20/22/24
npm run certify:rc
```

## Node interpreters available on the certification host

Discovered under the nvm-windows install root and invoked **directly** rather
than by switching the global symlink (switching mutates machine state and races
anything else on the host). Each version's own bundled npm is used, so the
matrix never tests one npm against four runtimes.

| Major | Version | Bundled npm |
|---|---|---|
| 18 | v18.20.5 | 10.8.2 |
| 20 | v20.15.1 | 10.7.0 |
| 22 | v22.14.0 | 11.12.0 |
| 24 | v24.19.0 | 11.17.0 |
