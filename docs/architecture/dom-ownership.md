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
repeated cycles. `tests/__vacuity_check.test.ts` keeps the detector honest by
proving it still reports a deliberately leaked range.

This catches leaks without depending on garbage collection, which is why it is
the primary tool rather than `WeakRef` sampling.
