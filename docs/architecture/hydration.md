# Hydration

## The headline fact

**SibuJS hydration uses a *replace* strategy, not an *adopt* strategy.**

```ts
export function hydrate(component, container, options) {
  const clientTree = component();
  // ...optional diagnostics...
  replaceChildrenSafely(container, clientTree);
  container.setAttribute("data-sibu-hydrated", "true");
}
```

The server-rendered subtree is **discarded** and the client tree is built fresh.
Server DOM is not adopted, and DOM node identity is **not** preserved.

This is deliberate, and the reasoning is sound: SibuJS bindings are created by
`component()` and are wired to the nodes *that call produced*. An in-place
reconciler could copy attributes onto the server nodes, but the reactive
bindings would still point at the discarded client nodes — so the visible DOM
would silently stop updating. Given a choice between *adopted but frozen* and
*replaced but live*, SibuJS chooses live.

Understand the consequences before deploying SSR:

| Consequence | Impact |
|---|---|
| No DOM identity preservation | node references captured pre-hydration go stale |
| Pre-hydration user input is discarded | a user typing before the bundle loads loses the edit |
| Pre-hydration focus is lost | the focused node is detached |
| No hydration performance benefit | the client tree is built regardless |
| **Mismatches cannot corrupt the DOM** | the client tree is authoritative, always |

The last row is a genuine advantage. Whole categories of hydration bug —
half-patched trees, duplicated rows, orphaned listeners, mismatched adoption —
are structurally impossible here.

**SSR in SibuJS is therefore best understood as first-paint HTML plus a client
render, not as work-sharing between server and client.** If your reason for
adopting SSR is SEO, first-contentful-paint, or link previews, this delivers it.
If your reason is to avoid re-rendering on the client, it does not.

## Mismatch policy

Because the client tree always wins, every mismatch has the same deterministic
resolution. This table is the contract:

| Mismatch | Detected? | Warns? | Patches? | Replaces? | Final DOM |
|---|---|---|---|---|---|
| Text differs | yes¹ | dev only¹ | no | yes | client value |
| Tag differs | yes¹ | dev only¹ | no | yes | client element |
| Attribute differs | yes¹ | dev only¹ | no | yes | client value |
| Attribute missing on one side | yes¹ | dev only¹ | no | yes | client set |
| Server node missing | yes¹ | dev only¹ | no | yes | client node present |
| Extra server node | yes¹ | dev only¹ | no | yes | extra node dropped |
| List order differs | yes¹ | dev only¹ | no | yes | client order |
| Route differs | not detected by `hydrate()` | — | — | — | see router-ssr.md |

¹ **Only when `diagnostics: true` is passed.** Detection is opt-in and costs a
full tree walk, so production pays nothing. Recovery is identical either way —
diagnostics change what is *reported*, never what is *rendered*.

Every row is covered by a test in `tests/ssr-hardening-hydration.test.ts`, and
the text/structural rows additionally in real browsers via
`tests-browser/hydration.spec.ts`.

### Diagnostics

```ts
hydrate(App, container, {
  diagnostics: true,
  onMismatch(report) {
    // { kind, path, serverValue, clientValue, message }
    telemetry.record(report);
  },
});
```

`kind` is one of `"tag" | "attribute" | "child-count" | "text"`. Without an
`onMismatch` handler, development builds log the first mismatch to the console
with its path and both values. At most 5 mismatches are collected, to avoid
log spam on a badly diverged tree.

Note: the walker descends through **element** children and compares each node's
**direct** text content in aggregate. It does not report per-text-node diffs,
which would be noisy on formatted HTML.

## Forms

Given the replace strategy, form state is governed by one rule:

> **Client state is authoritative. Anything the user did before hydration is
> discarded.**

That covers `value`, `checked`, `selected`, and focus. It is verified in all
three engines — a real Playwright `page.fill()` before hydration is overwritten.

If your application must preserve pre-hydration input, capture it yourself
before calling `hydrate()` and feed it into the component's initial state:

```ts
const draft = (document.querySelector("#name") as HTMLInputElement)?.value;
hydrate(() => Form({ initialName: draft ?? serverName }), container);
```

This is an application concern; the framework does not attempt it automatically,
because it cannot know which pre-hydration edits are meaningful.

## Lifecycle

- `onCleanup` handlers registered on the hydrated tree run when the container is
  disposed, exactly once.
- Re-hydrating the same container disposes the previous client tree first. This
  goes through `replaceChildrenSafely()`, so the outgoing tree's bindings,
  listeners, and lifecycle hooks are torn down rather than orphaned. (This was
  a real leak, fixed as H-001; see the findings document.)
- Hydration creates exactly **one** binding set and **one** listener per logical
  component instance. Verified by counting real clicks and real re-renders in
  all three browser engines.

## Islands

Islands hydrate independently. `hydrateIslands(container, registry)` activates
only the ids present in `registry`; every other island keeps its untouched
server markup. Hydrating a second island later does not re-run the first, and
island state never crosses between islands. See [islands.md](./islands.md).

## Invariants

- Hydration may not create duplicate effects or event handlers for one logical
  component instance.
- Re-hydration must dispose the outgoing client tree.
- Mismatch recovery must never leave structurally corrupted DOM.
- Async completion may not mutate a hydration boundary that has already been
  disposed.
- Hydrating one island may not implicitly activate unrelated islands.
