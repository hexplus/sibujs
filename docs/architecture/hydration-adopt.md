# Adopting hydration (`strategy: "adopt"`)

Status: **shipped in 4.14, opt-in.** `hydrate()` keeps the replace strategy
described in [hydration.md](./hydration.md) as its default; nothing changes
for an app that does not ask for adoption.

```ts
// Server: mark the output.
const { html, state } = await renderToStringAsync(() => App(), { hydration: "adopt" });
// or: renderRoute(routes, url, { hydration: "adopt" }), or the pre-renderer's `hydration: "adopt"`.

// Browser: bind to it.
await hydrate(() => App(), document.getElementById("app")!, { strategy: "adopt" });
```

On markup that matches what `App()` builds, the client tree is built **on the
server nodes**: every element a tag factory or `html` template creates is the
server's element, so bindings, listeners and refs attach to what is already on
screen. Images and iframes do not reload, text typed before the bundle loaded
stays, focus and scroll stay. Code: `src/core/rendering/adoptScope.ts` (core,
~550 B gzip), `src/platform/hydrateAdopt.ts` (`sibujs/ssr`).

## Ids: creation scopes, not a global counter

SibuJS builds trees bottom-up — a factory's children are evaluated before the
factory runs — so "the next node in document order" cannot be claimed. The
proposal used a request-wide creation counter instead. That breaks on the
most common server render: data arrives, a `when` rebuilds its branch, and
every element created after that point is numbered differently from the
browser's single build; two boundaries resolving in a different order shift
each other too.

**Deviation: ids are paths.** Each directive reserves a slot in its parent's
sequence when it is created (synchronously, so the slot is deterministic) and
opens a scope for its content. An element's id is its creation index inside
the scope it was built in:

```text
App scope ""           img#0  p#1  button#3  when → scope "4."
when branch "4."       ul#4.1       each → scope "4.0."
each row, key "a"      li#4.0.k1r9wi7g.0     (FNV-1a of the key)
```

A rebuild restarts its scope at 0, so the branch the server built after its
data arrived has the ids the browser's first build gives it, whatever happened
before. Scopes open at: `when`, `match`, each `each` row (keyed), reactive
children (`bindChildNode`), `lazy()`, `Suspense`, `Route()` / `Outlet()`
(keyed by the route record's path). Placeholders a boundary replaces (`lazy()`'s
loading span, a `Suspense` fallback) are built outside any scope, so they take
no id and cannot shift the ids after them.

The server emits the id as `data-sibu-h`. Plain `renderToString` and the
async renderers without `hydration: "adopt"` emit none.

## Claiming and placement

`hydrate(…, { strategy: "adopt" })` indexes the `data-sibu-h` elements under
the root and opens a hydration session. Every element creation inside a scope
asks the session for its id; a server element with that id, the same tag and
namespace, not claimed yet, is returned instead of a new element.

**Deviation: text and comment nodes are swapped, not adopted.** A reactive
text binding closes over the text node it created, and text nodes cannot carry
ids. So while a claimed element is being built, its `appendChild` puts each
child at a cursor over the server children: an adopted element already there
stays; a fresh text or comment node replaces the server node it corresponds to
(the next server node of its kind — a comment with the same text — past any
branch content of a preceding directive). The proposal's "zero `childList`
mutations" becomes: **zero element nodes created, added, removed or moved** on
matching markup; only text and comment nodes are swapped, which is invisible
and cannot reload anything. Adjacent server text nodes are kept apart with a
`<!--|-->` separator so the parser does not merge them.

These placement rules are instance overrides on the claimed elements (and the
root) for the length of the session, so the core's `appendChild` /
`insertBefore` calls need no hooks. The core needed only in-place guards: a
branch already after its anchor is not re-inserted, `replaceChildrenSafely`
keeps claimed nodes that are already the first children, `each` takes over the
server's `each:end`.

## Attributes

A claimed element ends with exactly the attributes the client writes, through
the client's policy. At claim time server attributes are removed, except those
whose removal would change the element's live state: `src` / `srcset` / `sizes`
on media, `poster`, `data` on `<object>`, a form control's `value` / `checked` /
`type`, `open`. Those are re-checked against the URL policy at once (an injected
`javascript:` value goes) and dropped when the session ends unless the client
wrote or read them. `on*` attributes are never serialized in the first place.

## Interaction before takeover

A claimed `<input>` / `<textarea>` / `<select>` whose state differs from its
markup (the user typed) keeps it: the session ignores the client's first value
writes to it, and when it ends it dispatches `input` and `change` on the control
so the app's handlers bring their state in line. Focus and scroll stay because
the nodes stay.

Selects, checkboxes and radios are snapshotted when the session STARTS, before
any client code runs. The client builds a select's options before the select
(an option's `selected` write changes the selection before the select is
claimed), and checking one radio unchecks its group (a sibling's write, or a
sibling joining the group, changes this one first) — so judging them at claim
time would see the client's writes, not the user's. Whether a control was
changed is likewise decided at the start, for every form control, and claiming
only looks it up. "Changed" is measured against the markup's own default.
Explicit `selected` attributes decide it when present, disabled options
included. Otherwise a drop-down picks an implicit default, and engines
disagree on which: the spec takes the first option not disabled, counting an
`<optgroup disabled>` as disabling its options; WebKit ignores the optgroup;
all-disabled drop-downs differ too. So the session asks the engine: the
select's markup (attributes only, which the user's choices do not change) is
parsed again with `DOMParser`, an inert document where nothing loads or runs,
and that selection is the default. Without `DOMParser` the spec's rule stands
in. An untouched select then gets the client's initialization, with nothing
replayed. When the session ends the snapshot is put back, before the events
are replayed:

- The snapshot is the exact set of selected option NODES, each with its value
  and its occurrence among the options sharing that value. An empty set is a
  selection (a cleared multiple select, `selectedIndex = -1`) and is restored
  as empty; it is not the same as a select that has no snapshot (untouched).
- A selected option the client adopted keeps its selection wherever it moved,
  as long as its value is unchanged — so the second of two equal-valued
  options stays the selected one.
- A selected option the client REBUILT (its server node is gone) is matched
  among the options the client built with the same value: the one at the same
  occurrence, else the first not yet matched. With repeated values this is a
  deterministic best guess, not identity — nothing identifies a rebuilt option
  — but it is one to one: it never selects more options than were selected,
  nor a server option the user left alone.
- A selected option with no counterpart is dropped. When nothing of a
  non-empty selection is left, the client's own selection stands and no event
  is replayed.

A select gets no property override for this. Every instance
override is removed when the session ends, and also when the build throws.

## Deferred and async content

`when` / `match` / `each` first renders run in microtasks, `lazy()` chunks and
route loads later. The session registers that work (`trackPending` reports to
it in the browser) and ends once it has settled, or after `timeout` (10 s).
While it runs, a claimed `lazy()` container or `Suspense` boundary keeps the
server's content on screen instead of showing its loading UI, and a route
outlet shows no spinner. Data fetches do not hold the session: transferred data
is already in the cache, and a background refetch does not change structure.

`ClientOnly` renders its fallback during the session (adopting the server's
fallback) and swaps in its content in one synchronous step when it ends.

## Mismatch

A claim that fails creates a fresh element and reports it. When the session
ends, every server element nothing claimed is removed. So a divergent subtree is
replaced on its own; its siblings stay adopted. Reports (`onMismatch`, or a
development warning) carry the kind (`tag`, `missing`, `extra`, `text`), the
DOM path, the id, both sides, and the likely cause (a browser-only read during
render, non-deterministic values, data the server did not have). A root that
does not match replaces the whole tree and says so in development.

`createId()` lines up: the server counter is request-scoped and starts at 0, as
a fresh page does.

## Limitations

- `KeepAlive`, `DynamicComponent`, `Portal` and `KeepAliveRoute` open no scope.
  Their content is created fresh in the browser and replaces the server's
  locally (reported as mismatches).
- An element created with `document.createElement` directly (not through a tag
  factory or `html`) is not adopted.
- Server output must not be reformatted between render and delivery
  (whitespace text nodes would not pair).
- The session overrides methods on claimed instances until it ends; code that
  inspects own properties of those nodes during the session sees them.

## Tests

`tests/ssr-hydrate-adopt.test.ts`: zero created/moved elements and live
bindings on matching markup; the fixture landing page through the router
(creates no element, keeps the hero `<img>` node, no `/api/catalog` request);
injected attributes stripped; a deliberate mismatch replacing only its
subtree; typed input and focus surviving; `ClientOnly` swap; `createId()`;
`lazy()` content adopted; transferred query data. `tests/ssr-adopt-select.test.ts`:
single and multiple selects, option- and select-level writes, an untouched
select, reordered and removed options, emptied selections, equal-valued
options, `<optgroup>`, rebuilt options, replayed events, radios, and no
override left behind; `tests-browser/ssr-adopt-select.spec.ts` checks the
emptied and equal-valued cases with the real control in three browsers. The replace strategy's own suite is unchanged.
