# Design note: adopting hydration (`strategy: "adopt"`)

Status: **proposed, not implemented.** 4.12 ships SVG serialization, the no-DOM
error, `embed()` and the nullable getter types; the adopting mode was scoped
out because it does not fit one reviewable change. This note records the
approach, the marker format and the risks so it can be built as its own
release. Until then `hydrate()` keeps the replace strategy described in
[hydration.md](./hydration.md), and no partial adopt mode exists.

## Goal

```ts
hydrate(App, root, { strategy: "adopt" });
```

On markup that matches what `App()` builds, hydration binds effects,
listeners, refs and `onMount` to the **existing** server nodes. A
`MutationObserver` on `root` records zero `childList` mutations; clicks,
reactive text and reactive attributes work. A subtree that does not match is
built fresh and swapped in for that subtree only, and reported through
`onMismatch` and the development diagnostics. `strategy: "replace"` stays the
default.

## Why it does not fit in one change

Adoption has to happen while the tree is being built, because a binding closes
over the node its builder created; it cannot be moved to another node later.
That puts a hook in every place the core creates or inserts a node:

| Site | What adoption needs there |
|---|---|
| `tagFactory` (and `customElement`) | claim the server element instead of `createElement` |
| `appendChildren`, the `textContent` fast path | verify a child is already in place instead of appending; reuse an equal text node |
| `bindChildNode` placeholders | claim the existing `<!---->` and the nodes after it |
| `when` / `match` | the deferred first render claims the server branch instead of inserting one |
| `each` | claim rows by key between `each:anchor` and `each:end` |
| `Fragment`, `html` templates | the same claim / verify as the tag factory |
| `setSafeAttribute` | write only differing values; remove server attributes the client did not write |

`cdn.global.js` has about 60 B of gzip headroom under its budget after 4.12, so
the hooks must cost almost nothing when unused (see "Bundle cost").

## Approach: creation-order claiming

SibuJS builds trees bottom-up — a factory's arguments, its children, are
evaluated before the factory runs — and components may build nodes in any
order before arranging them. Claiming "the next node in document order" would
therefore fail on ordinary code. Instead, the server and the client agree on a
**creation sequence**: the n-th element `App()` creates on the server is the
n-th element it creates on the client, as long as the component is
deterministic.

1. **Server.** Inside `runInSSRContext(fn, { hydration: "adopt" })` the tag
   factories stamp each element with its creation index from a counter in the
   request's SSR store (request-scoped, like `idCounter`). `renderToString`
   emits it as `data-sibu-h`.
2. **Client.** `hydrate(App, root, { strategy: "adopt" })` indexes
   `root.querySelectorAll("[data-sibu-h]")` into a map, installs an adopt
   context, and calls `App()`. Each element creation takes the next index; if
   the map holds an element with that index, the same tag and namespace, and it
   is not yet claimed, the factory returns it instead of a new element.
3. **Children.** When a factory appends children to a claimed element, it
   checks each child against the element's existing `childNodes` in order. A
   child already in place is not re-inserted; a text child equal to the server
   text node binds to that node.
4. **Attributes.** Writes go through `setSafeAttribute` as today, skipping a
   write whose value is already present. After the element's props are
   applied, server attributes the client did not write are removed, so the
   adopted element ends with exactly the client's attribute set and policy.
5. **Deferred renders.** `when`, `match` and `each` render their first branch
   in a microtask. The adopt context is captured with the owner scope those
   renders already carry, and released once the last deferred first render
   has run.
6. **Mismatch.** A claim that fails (index missing, other tag, already claimed)
   creates a fresh node. When that node is appended where a server node sits,
   the server node is replaced by it — one `childList` mutation for that
   subtree only — and an `onMismatch` report is produced (`kind: "tag"`,
   `"child-count"`, `"text"`; a new `"order"` kind for a node in the wrong
   position). Nothing outside the subtree changes.
7. **Cleanup.** `data-sibu-h` attributes are removed after hydration (attribute
   mutations only), and `root` gets `data-sibu-hydrated="adopt"`.

`onMount` needs no change: an adopted element is already connected, so its
callbacks run in the microtask after construction, as they do for a
freshly mounted tree.

## Marker format

All markers are emitted only by an SSR render that asked for adoption; plain
`renderToString` output is unchanged.

| Marker | Where | Purpose |
|---|---|---|
| `data-sibu-h="<n>"` | every element built by a factory or `html` | creation index |
| `<!--when-->` … `<!--/when-->` | around a `when` branch | branch extent (the start marker exists today) |
| `<!--match-->` … `<!--/match-->` | around a `match` branch | branch extent |
| `<!--each:anchor-->` … `<!--each:end-->` | around a list (exists today) | list extent |
| `<!--k:<key>-->` | before each `each` row | row identity; the key is written with the comment-terminator escaping SSR already applies |
| `<!--\|-->` | between two adjacent text nodes | keeps the HTML parser from merging them, so child positions line up |

## Risks

- **Non-deterministic components.** `Date.now()`, `Math.random()`,
  `typeof window` checks, different data or locale on the two sides shift the
  creation sequence. The result is correct but degrades to subtree
  replacement; diagnostics should name the first index that diverged.
- **Async construction.** `lazy()`, `Suspense` and a direct async route
  component build after an `await`. Their nodes would be created outside the
  adopt context and replace their server markup. A first version should
  document them as replace-only.
- **Text normalisation.** The parser merges adjacent text and decodes
  entities; whitespace-only text from formatted HTML has no client
  counterpart. Hence the text separator marker, and server output must not
  be reformatted between render and delivery.
- **Pre-hydration input.** An adopted `<input>` keeps what the user typed,
  unlike replace mode. That is usually desired, but it is a difference to
  document, and a `value` binding's first write must not clobber it silently.
- **Trust.** Adopted markup may come from a stale cache or a proxy. Step 4
  (exact client attribute set, through the client policy) keeps server-only
  or injected attributes from surviving; `on*` attributes are already never
  serialized. Text content is replaced when it differs.
- **Concurrency.** Two `hydrate()` calls in one tick must not share an adopt
  context; the context is per call and keyed to its owner scope.
- **Bundle cost.** Seven hook sites in the core. To keep `cdn.global.js`
  inside its budget, each site should test one module-level slot
  (`if (adopt) …`) that `sibujs/ssr`'s `hydrate` fills, keeping the claiming
  logic out of the core bundle. Estimated core cost: under 200 B gzip.

## Acceptance tests to write with it

- Matching markup: a `MutationObserver` on the root records zero `childList`
  records during `hydrate`; a click handler runs once; reactive text and an
  attribute update in place; refs point at the server nodes.
- `when` / `match` / `each` adopt their server branches and rows, then update
  normally.
- A deliberately mismatched subtree is replaced alone, with one report, and its
  siblings keep their identity.
- Server attributes the client does not write are removed; a `javascript:`
  `href` injected into cached markup does not survive.
- Plain `renderToString` output and `strategy: "replace"` are byte-for-byte and
  behaviour-for-behaviour unchanged.
- The same suite in Chromium, Firefox and WebKit.
