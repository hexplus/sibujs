# Context

## What SibuJS means by "context"

> **`context()` is an application-global reactive value.**
>
> It is **not** subtree-scoped. It is **not** SSR request-scoped.

This matters because the name carries strong expectations from React, Vue, and
Solid, where context is hierarchical: a provider scopes a value to its subtree,
and two branches can hold different values simultaneously. SibuJS does not do
that. `context()` creates one reactive signal, and `provide()` changes it for
every consumer in the process.

The API shape reflects this honestly — there is no provider *component* and no
subtree boundary:

```ts
const Theme = context("light");

Theme.provide("dark");   // sets the global value, returns a restore handle
Theme.use();             // reactive getter
Theme.get();             // non-reactive read
Theme.set("system");     // update
Theme.withContext(v, fn) // scope a SYNCHRONOUS callback
```

Think of it as a named global signal with scoping helpers, not as dependency
injection.

## What it is good for

- Application-wide values that genuinely have one value at a time: theme,
  locale, feature flags, the current user in a client-only app.
- Avoiding prop-drilling for those values.

## What it must not be used for

- **Request-specific SSR data.** Concurrent requests share the value, so one
  request can observe another's. See below.
- **Per-subtree values.** Two components cannot see different values at once.
- **Scoping across `await`.** See "Async behaviour".

## SSR behaviour — the important limitation

`context()` lives outside `runInSSRContext()`'s `AsyncLocalStorage` isolation.
Under concurrent SSR:

```text
Request A: User.provide("Alice")   ──┐
                                     │  A parks on an await
Request B: User.provide("Bob")       │
Request B: completes                 │
                                     │
Request A: resumes ──────────────────┘
Request A reads: "Bob"   ← another request's value
```

This is a **documented limitation, not a bug** — it follows directly from the
value being global. But it is a serious footgun for server rendering, so
development builds warn when `provide()`, `set()`, or `withContext()` is called
while SSR is active:

```text
[SibuJS] context.provide() called during SSR. SibuJS context() is
application-global — it is NOT isolated per request, so a concurrent request
can observe this value. Do not use context() for request-specific SSR data;
pass it explicitly or use request-scoped storage instead.
```

For request-specific server data, either pass values explicitly through your
component tree, or use storage that is request-scoped by construction — the
query cache is, via `getRequestScopedCache()`.

## Async behaviour

`withContext(value, fn)` scopes **only the synchronous portion** of `fn`. The
previous value is restored when `fn` *returns*, which for an `async` callback is
when it returns its promise — not when that promise settles:

```ts
Theme.withContext("dark", async () => {
  Theme.get();          // "dark"  — synchronous portion is scoped
  await loadSomething();
  Theme.get();          // NOT "dark" — the scope already unwound
});
```

Development builds warn when `withContext` receives a callback that returns a
promise.

### Why this is not "fixed" with a promise-aware restore

An obvious-looking fix is to restore in `.finally()` when the callback returns a
thenable. That would make the single-callback case read correctly while leaving
the concurrent case broken:

```text
withContext("A", async …)   ─┐
withContext("B", async …)   ─┤  both mutate ONE global value
                             │
   whichever restores last wins, and neither scope was ever isolated
```

Because the value is global, promise-aware restoration cannot provide isolation
— it would only make the hazard harder to notice. Genuine async scoping requires
request-local or continuation-local storage, which is a different feature.

The contract is therefore stated plainly rather than papered over: **`withContext`
is synchronous-only.**

## Nesting

Synchronous nesting works and unwinds in order:

```ts
Theme.withContext("A", () => {
  Theme.get();                          // "A"
  Theme.withContext("B", () => {
    Theme.get();                        // "B"
  });
  Theme.get();                          // "A"
});
Theme.get();                            // default
```

The previous value is restored even if the callback throws.

## Reactivity

`use()` returns a reactive getter, so consumers re-run when the value changes.
Disposal follows the normal reactive rules — see
[reactivity.md](./reactivity.md).

## Summary

| Property | Behaviour |
|---|---|
| Scope | application-global |
| Subtree-scoped | no |
| SSR request-scoped | **no** — dev warning on SSR use |
| Reactive | yes |
| Sync scoping (`withContext`) | yes |
| Async scoping | **no** — dev warning on async callback |
| Nesting (sync) | yes, unwinds correctly, exception-safe |
