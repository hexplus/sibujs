# DOM Ownership and Disposal

This document defines who owns which DOM nodes in a SibuJS application, and
whose job it is to tear them down. It exists because the single largest class of
bugs in a fine-grained reactive framework is not incorrect rendering — it is
correct rendering that never gets cleaned up.

## The core invariant

> **Any SibuJS-owned DOM subtree that SibuJS removes must pass through
> `dispose()` before it becomes unreachable.**

A node becomes *unreachable* the moment it is detached from a tree that some
future `dispose()` walk would have reached. After that point nothing in the
framework can find it again: its reactive bindings keep re-running against
detached DOM, its listeners stay attached, its observers keep observing, and its
`onCleanup` hooks never fire.

This matters because `dispose()` walks **children**, not siblings:

```ts
dispose(node); // visits node and node.childNodes, recursively — nothing else
```

So the invariant has teeth only where ownership is explicit. The rest of this
document makes it explicit.

## Ownership rules

### Node ownership

A node is owned by whatever created it and attached it. Bindings registered via
`registerDisposer(node, fn)` are stored in a `WeakMap` keyed by that node, and
run when `dispose(node)` reaches it — either directly, or because an ancestor
was disposed.

### Parent vs child disposal

`dispose()` collects the subtree in pre-order and tears it down in **reverse**,
so children are always disposed before their parents. A parent's disposer can
therefore assume its children are already clean.

Disposal is **idempotent**. Each node's disposer list is snapshotted and deleted
*before* the disposers run, so re-entrant `dispose()` on the same node during
teardown neither re-runs disposers nor loops. Disposers added *during* teardown
are drained afterwards, bounded by a pass cap.

### Range ownership

Several primitives are **anchored**: they return a `Comment` node and manage
content that are *siblings* of that anchor, not children of it.

```text
<!-- each:anchor -->   <- the returned node; the only thing an ancestor walk reaches
row A                  <- sibling, NOT a child
row B                  <- sibling
<!-- each:end -->      <- sibling sentinel
```

An ancestor `dispose()` reaches only the anchor. **The anchor's disposer is
therefore responsible for the entire logical range.** It must:

1. stop the range's reactive subscription;
2. dispose every owned node in the range;
3. remove every owned node from the DOM;
4. remove any sentinel markers it inserted;
5. clear internal bookkeeping (key maps, node maps, buffers);
6. be idempotent;
7. tolerate nodes an outside party already detached.

`each()` and `KeepAlive()` both implement exactly this contract. A range
primitive that registers only its `untrack` teardown is **broken** — the rows
stay on screen and every row binding leaks. That was a real defect, fixed in
this hardening pass and pinned by `tests/hardening-disposal.test.ts`.

### Keyed rows: identity is not value freshness

A keyed `each()` row is reconciled as a small record, not just a DOM node:

```text
row
 ├── key            stable identity
 ├── item cell      reactive; written when reconciliation reuses the row
 ├── index cell     reactive; written when the row's position changes
 └── DOM range      created ONCE by render()
```

When reconciliation encounters a key it already has, it keeps the DOM range and
the renderer's output and **writes the row's cells** instead. `render` therefore
runs exactly once per key, while anything inside the row that reads `item()` or
`index()` re-runs through the normal reactive path.

That separation is the point. Keeping a row's DOM node is about *identity*;
keeping its contents correct is about *freshness*. Conflating them gives you one
of two bugs — recreate the row on every update and you lose focus, animation and
scroll state; reuse it without refreshing the cells and the row silently
displays the previous item's data. Replacing `{id: 1, name: "Alice"}` with
`{id: 1, name: "Bob"}` must keep the same element **and** show `Bob`.

Reading `item()` subscribes to that row's cell, not to the whole-array signal,
so mutating one row never re-runs another's bindings. Cells use signal equality:
a row whose item and index are both unchanged writes nothing and re-runs
nothing.

Effects created inside `render` are **not** owned automatically — SibuJS has no
implicit owner tree. Bind them to the row explicitly:

```ts
each(items, (item) => {
  const el = div();
  const stop = effect(() => { el.textContent = item().name; });
  registerDisposer(el, stop);       // now the row owns the effect
  return el;
}, { key: (i) => i.id });
```

Row disposal runs that disposer exactly once when the key leaves the list, and
again never.

### Component ownership

A component is a plain function returning a node. It owns whatever it creates.
It does not own nodes handed to it as children — those belong to the caller, and
disposing them is the caller's business.

### Detached cached nodes

A node that SibuJS deliberately keeps alive while detached (`KeepAlive`'s cache,
a `Suspense` child created but not yet committed) is unreachable by any
ancestor walk *by construction*. The primitive holding the reference owns it and
must dispose it explicitly in its own disposer. Both do.

## Per-primitive ownership

| Primitive | Returns | Owns | Disposal responsibility |
|---|---|---|---|
| `each()` | anchor `Comment` | all rows + `each:end` sentinel (siblings) | anchor disposer tears down the whole range |
| `KeepAlive()` | anchor `Comment` | every cached subtree, attached or detached | anchor disposer disposes the whole cache; eviction disposes the evicted entry |
| `Suspense()` | container `Element` | the fallback until commit; the child until it is attached | outgoing fallback disposed at commit; uncommitted child disposed by the container's disposer |
| `lazy()` | container `Element` | the loading placeholder, then the loaded subtree | replacement disposes the outgoing content; a disposed container refuses late loads |
| `Portal()` | anchor `Comment` | the content rendered into the **target** | **source owns it** — the anchor's disposer disposes and removes it from the target |
| `DynamicComponent()` | container `Element` | the current component instance | disposes outgoing children before each swap |
| `ErrorBoundary()` | container `Element` | children and fallback; the async container | a disposed boundary disposes late-arriving async content instead of attaching it |
| `bindChildNode()` | teardown fn | the nodes it last inserted | disposes any outgoing node not carried over to the new set |

### Portal ownership, stated explicitly

**The source owns portal content, not the target.** `Portal()` returns an anchor
that stays in the source position; the content is appended to the target
element. When the anchor is disposed, its disposer disposes the content and
removes it from the target.

The target is *borrowed*, never owned. Portal does not dispose the target, and
destroying the target element is the application's responsibility — SibuJS
cannot observe that and will not attempt to. This avoids the failure mode where
both source and target try to clean up, or neither does.

### Suspense ownership

The fallback belongs to the boundary until content is committed. Committing
**disposes the outgoing fallback and does not dispose the incoming content.**

An async completion may not mutate a boundary that has already been disposed. A
`Suspense` or `lazy()` container torn down while its promise is in flight
refuses the late result rather than building detached DOM.

## The native-DOM hazard

Native DOM APIs remove nodes without any SibuJS teardown:

```ts
parent.replaceChildren(next);   // outgoing children silently orphaned
parent.innerHTML = "";          // same
node.remove();                  // same
parent.removeChild(child);      // same
```

Every one of these is a place the invariant can be violated. Framework code must
either dispose first, or route through the shared helper:

```ts
import { replaceChildrenSafely } from "./dispose";

replaceChildrenSafely(container, nextNode);
```

`replaceChildrenSafely()` disposes the outgoing children and then performs the
native replacement, under this rule:

> **`replaceChildrenSafely()` must dispose all removed SibuJS-owned content, but
> it must never dispose any node that is part of the incoming replacement set —
> even when that node is currently nested inside an outgoing subtree.**

The second half matters more than it looks. Native `replaceChildren()` *moves* a
node out of the content being replaced rather than destroying it:

```text
parent                    replaceChildrenSafely(parent, incoming)     parent
└── outer          ────────────────────────────────────────────▶     └── incoming
    └── inner
        └── incoming
```

A naive implementation that disposed `outer` before moving `incoming` would tear
down `incoming` along with it, leaving a node in the final DOM whose reactive
resources are already destroyed. So incoming nodes are **detached first**, before
any outgoing root is disposed — the dispose-walk then cannot reach them. Every
other part of those outgoing subtrees (`outer` and `inner` above) is still
disposed exactly once, so preserving one descendant never leaks its former
ancestors or siblings.

Skipping disposal of an outgoing child merely *because* it contains an incoming
node would be the wrong fix: it would leak the rest of that subtree.

**Application code that detaches a SibuJS-managed node itself is responsible for
calling `dispose()` on it first.** SibuJS does not install a global
`MutationObserver` to garbage-collect arbitrary manual removals; the lifecycle
observer handles `onMount`/`onUnmount`, not binding teardown.

This is why `replaceChildrenSafely()` is exported publicly alongside `dispose()`
and `checkLeaks()`, rather than kept internal: application code hits this hazard
for exactly the same reason framework code does.

```ts
import { replaceChildrenSafely } from "sibujs";

// Instead of: container.replaceChildren(newContent)  ← leaks
replaceChildrenSafely(container, newContent);
```

## Platform helpers that own trees

The invariant applies to the whole public surface, not only the reactive core.
These helpers replace or clear content they own, and all route through
`replaceChildrenSafely()`:

| Helper | What it owns |
|---|---|
| `createMicroApp().mount()` / `.unmount()` | the mounted component tree (light DOM or shadow root) |
| `defineRemoteComponent()` | the loading placeholder, swapped for the resolved component |
| `defineElement()` teardown | the rendered subtree inside a custom element |
| `DynamicComponent()` | the currently-rendered component |
| `DOMPool.release()` | children of a recycled element, before it re-enters the pool |
| `render()` / `unmountAll()` (testing) | the test container's contents |

`DOMPool` is the least obvious of these: an element returned to the pool still
carrying live bindings hands them to whatever renders into it next.

## Singleton document resources

`document.title` and `<base>` are **not** ordinary owned nodes. A page can hold
any number of `<meta>` tags, each independently created and removed, so
"remember my element, delete it on cleanup" is complete teardown for those. A
singleton has exactly one effective value, so setting it is *taking over* from
whoever held it — and teardown means *giving it back*.

The natural-looking approach, where each owner snapshots the previous value and
writes it back, is wrong whenever three owners overlap:

```text
A takes the title ("Dashboard")   snapshot: "Original"
B takes the title ("Settings")    snapshot: "Dashboard"
C takes the title ("Report")      snapshot: "Settings"
B disposes  → writes "Dashboard"  ← C is the visible owner and just got clobbered
```

Overlapping lifetimes are the normal case — a layout `Head` outliving a page
`Head`, a modal's `title()` inside a route's — so this is an everyday reordering
bug rather than a corner case.

`src/utils/singletonResource.ts` replaces the snapshot with an **owner stack**:

- writes always come from the current top,
- releasing a non-top owner just removes its entry and changes nothing visible,
- a superseded owner's reactive update is recorded but does not steal the
  resource back,
- emptying the stack restores the value captured before the first owner arrived.

`src/utils/documentResources.ts` builds the two concrete managers on it and
holds them in `globalSingleton` slots, so `Head({ title })` (platform) and
`title()` (browser) — and any duplicated module copy — contend for **one** stack.
Two independent stacks over one global resource would reintroduce exactly the
clobbering the stack exists to prevent.

The `<base>` manager reuses a single element rather than removing and appending,
because HTML honours only the first `<base>`; that is what makes "latest owner
wins" true in the document rather than only in the model. A server-rendered
`<base>` is captured on first acquire and restored on release — it used to be
deleted outright, permanently changing how every relative URL on the page
resolved.

> A consequence worth knowing: an owner that is never released stays on the
> stack. `title()` returns a disposer for this reason, and leaking it means the
> next release hands control back to the leaked owner rather than to the
> document's original title.

## Verifying the invariant

The rule is testable, not merely documented. `checkLeaks()` returns the number
of live DOM bindings in development builds, so any mount/destroy cycle can
assert that the count returns to its baseline:

```ts
const before = checkLeaks();
mountSomething();
destroyIt();
expect(checkLeaks()).toBe(before);
```

`tests/hardening-memory.test.ts` applies this to `each()`, `Suspense`,
`Portal`, `KeepAlive`, `ErrorBoundary`, and nested component trees across
repeated cycles. `tests/leak-detector-meta.test.ts` keeps the detector honest by
proving it still reports a deliberately leaked range.

This catches leaks without depending on garbage collection, which is why it is
the primary tool rather than `WeakRef` sampling.
