# Release plan — SibuJS 4.0

## Version decision

| Item | Value |
|---|---|
| Version in `package.json` | `4.0.0-rc.1` |
| Previous released version | `3.4.1` |
| Previous engine support | `node >=18.0.0` |
| New engine support | `node >=22.3.0` |
| Breaking change | **YES** |
| Planned release | **4.0.0** |
| Planned RC | **4.0.0-rc.1** |

**The next release requires a major version bump.** Supported Node moved from
`>=18.0.0` to `>=22.3.0`. Under Semantic Versioning that is breaking on its own,
independent of any source change: an install that succeeded yesterday now emits
`EBADENGINE`, and fails outright under `engine-strict=true`. Publishing this as
`3.4.x` or `3.5.x` would misrepresent the compatibility break.

`package.json` is now set to `4.0.0-rc.1` and `CHANGELOG.md` carries a
`## [4.0.0-rc.1]` section. **Do not publish 3.x with the new engine
constraint** — the two must move together.

### Why 22.3.0 and not 22.0.0

`process.getBuiltinModule` — the only synchronous way to load a builtin module
from ESM, and therefore the only way the ESM build can obtain
`AsyncLocalStorage` — arrived in **Node 22.3.0**. Node 22.0–22.2 fail the same
SSR request-isolation gate that Node 18 and 20 fail. A floor of `22.0.0` would
claim three patch releases that do not work.

Measured directly, not inferred:

```text
node 22.2.0   getBuiltinModule=undefined   isolation UNSUPPORTED
node 22.3.0   getBuiltinModule=function    isolation SUPPORTED
```

## Release checklist

Ordered. Nothing here should be automated away — each step is a decision point.

- [x] **Set the version** to `4.0.0-rc.1` in `package.json`. Done.
- [ ] Confirm `engines.node` is `>=22.3.0` in the packed tarball, not just the
      repository (`npm pack` then inspect `package/package.json`).
- [ ] Run `npm run certify:rc` and confirm **all gates PASS, 0 NOT TESTED**.
- [ ] Confirm the Node matrix line reads `22.3.0:PASS 22:PASS 24:PASS`.
- [ ] Confirm the tarball is 113 entries: `dist/`, `README.md`, `LICENSE`,
      `package.json` — no tests, scripts, fixtures, lockfile, or CI config.
- [ ] Publish with the `rc` dist-tag so `npm install sibujs` keeps resolving 3.x:
      `npm publish --tag rc`.
- [ ] Verify `npm dist-tag ls sibujs` shows `latest` still on 3.x.
- [ ] Announce the Node requirement prominently — it is the only thing that
      breaks for an existing user.

Promote to `4.0.0` and move the `latest` tag **only after** real-world RC
validation (below) reports clean.

## Feature freeze

In effect from this pass until the RC has real-world evidence.

**Allowed during the RC:**

- bug fixes with a reproducer
- compatibility fixes
- documentation
- release tooling
- small, clearly safe performance fixes

**Not allowed:** new framework features, new public API, refactors of certified
subsystems without a reproduced defect.

## Real-world validation

Automated certification and production use are different evidence layers. The
classification stays **PRODUCTION-HARDENED CANDIDATE** until sustained real use
exists — no amount of further automated testing changes that.

Three profiles, real applications rather than fixtures:

| Profile | Exercises | Watch for |
|---|---|---|
| **Client-only** | reactivity, keyed lists, router, disposal over long sessions | uncaught browser exceptions, memory growth across navigations, router/history divergence |
| **SSR** | request isolation under real concurrency, hydration, streaming | cross-request data bleed, SSR latency tail, hydration mismatches, process exit behaviour |
| **Data-heavy** | query cache, invalidation, mutations, refetch under churn | stuck `fetching` flags, cache growth, retry storms, unhandled rejections |

The SSR profile carries the most weight. NODE-002 was a silent cross-request
data bleed that no unit test caught for the entire life of the code; its fix is
guarded by a runtime warning, and production is where that warning either stays
quiet or does not.

## Known limitations carried into the RC

Not defects — documented characteristics and deliberate deferrals.

| Item | Status |
|---|---|
| Benchmark regression gate | **Informational only** — baseline refreshed, but noise on a shared host exceeds the threshold (BENCH-001) |
| `TYPE-006` — `generateEslintConfig` returns `Record<string, unknown>` | Deferred; lives in `src/build/`, needs owner sign-off |
| `TYPE-010` residual — `<select multiple>` binds `string[]` vs `SelectProps.value: reactive<string>` | Deferred; needs wider tag-prop-type changes |
| Bun / Deno / DOM-less edge runtimes | Not tested |
| `browserslist` minimum browser versions | Not tested — only current engines |
| Consumer-side `node16`/`bundler` TypeScript resolution | Not tested |
| Streaming Suspense | Batched, not per-boundary progressive — documented, not a bug |
| SSR requires a server DOM implementation | Documented; not bundled |

## Post-RC follow-ups

1. Re-record the benchmark baseline on the host that will enforce it, then raise
   the threshold until three consecutive no-change runs are clean.
2. Decide TYPE-006 and the TYPE-010 multi-select residual with the `src/build/`
   and tag-prop-type owners.
3. Test Bun and Deno if either becomes a supported target.
4. Consider `./package.json` in `exports` (PKG-001) and CJS code-splitting
   (PKG-002) — both open from RC certification, neither a correctness issue.
