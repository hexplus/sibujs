# Changelog

All notable changes to SibuJS will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---
---

## [Unreleased]

### Fixed — failed construction left subscriptions nobody could release

- **`effect()`** whose first run throws now releases the dependency edges that
  run recorded and runs the cleanups it registered before rethrowing. It never
  returned a disposer, so it stayed subscribed and re-ran on later writes.
  Neither `effect:create` nor `effect:destroy` is emitted for it.
- **`derived()`** whose initial getter throws now unsubscribes from the sources
  it read before rethrowing. The accessor was never returned, so `dispose()` was
  unreachable and every source kept the failed computed alive.
- **`mount()`** of a component function is a render transaction: if the
  component throws, or the append fails, every binding and listener it
  registered is released before the error reaches the caller. A pre-built node
  passed to `mount()` belongs to the caller and is never rolled back.
- **DevTools hook failures are contained.** A throwing `effect:create`,
  `computed:create` or `app:init` emit aborted construction after the effect,
  computed or tree was already live, so the caller never received its disposer
  or `unmount()`. A throwing `signal:update` or `computed:update` emit aborted a
  write after the value changed but before subscribers were notified, and a
  throwing `signal:create` made `signal()` throw. Every core emit now swallows
  hook errors, as the destroy events already did.

### Fixed — `Fragment()` and `mount()` of a fragment

- A function child of `Fragment()` is reactive, as it is in a tag factory. It
  was evaluated once, so `Fragment([() => count()])` never updated. It renders
  after a placeholder comment that owns the binding, so disposing the parent the
  fragment was appended to stops it.
- `mount(Fragment([...]))` tracks the range the fragment filled, and
  `unmount()` disposes and removes everything in it, including nodes a reactive
  child rendered after mounting. It used to dispose the emptied fragment and
  leave the mounted children live in the container. The range is drained node by
  node while its boundary markers are re-checked, so a node a teardown inserts
  into it is removed too; the safety ceiling counts only nodes teardowns add, so
  a fragment of any size unmounts completely, and if the ceiling is reached the
  markers stay so the rest remains reachable. If outside code removed or reordered a marker, nothing
  past that point is touched and the loss is reported (`phase: "cleanup"`,
  `name: "mount"`), instead of removing whatever follows in the container.

### Fixed — `onMount()` cleanup skipped on native removal

The cleanup returned from an `onMount()` callback now runs through the same
once-only path as `onUnmount()`, so `element.remove()` runs it as well as
`dispose()`. A callback that removes or disposes its own element has its cleanup
run immediately — `dispose()` leaves the element connected, so a cleanup
attached after its disposer queue had drained would never have run.

### Fixed — `catchError()` missed rejections from a `PromiseLike`

A returned thenable is adopted with `then` read once instead of calling
`.catch()`, which a `PromiseLike` need not have. The missing method used to be
reported as a synchronous failure while the real rejection went unobserved. A
throwing `then` accessor is reported as an async failure.

### Added — `detached()`

`detached(fn)` runs `fn` outside any render transaction and returns its result.
Nothing created inside it belongs to the render that happens to be running, so
that render failing leaves it alive. Use it for resources meant to outlive the
render — a shared store, or a value cached on first use:

```ts
let cart: DerivedAccessor<number> | undefined;
const cartCount = () => (cart ??= detached(() => derived(() => items().length)));
```

### Fixed — a failed render left resources it created subscribed

A render that throws now releases everything it created, not only the bindings
registered on its nodes:

- **Standalone resources.** An `effect()`, `derived()`, `watch()` or
  `asyncDerived()` created inside a render that later throws is disposed with
  the rollback (an `asyncDerived()` also aborts its request). The render never
  returned, so nobody held their disposers. A render that succeeds leaves them
  manually owned, exactly as before; a nested render that succeeds hands them to
  the enclosing one, whose failure still releases them. **Behavior change:** a
  render owns what it creates even if it stored it somewhere longer-lived, so a
  shared or lazily cached resource first created by a render that then throws
  is disposed (a `derived()` freezes at its last value). Create such resources
  inside `detached()`.
- **Every render factory is a transaction.** `each()` rows, `when()` / `match()`
  branches, `show()` thunks, `KeepAlive()` cases, `lazy()` components (already
  loaded or not), `Suspense()` content and fallback, `Portal()` content,
  `ErrorBoundary()` children and fallback, `resolveComponent()` and
  `DynamicComponent()` all run the user factory as a render transaction, like
  `mount()`. A factory that throws part-way — replaced by an error placeholder
  or a boundary fallback — leaves none of its bindings behind.
- **Deferred first renders are reported.** `when()`, `match()` and `KeepAlive()`
  render for the first time in a microtask when their anchor had no parent yet.
  A throw there escaped as an uncaught exception; it is now reported with the
  anchor as its node, so the nearest `ErrorBoundary` can claim it.
- `KeepAlive()` ignores inherited case keys: `"toString"` is not a case.

### Fixed — `Fragment()` flattens every nesting level

`Fragment([[[a, b]]])` stringified the inner array instead of appending `a` and
`b`. Children are flattened at any depth, skipping `null`, `undefined` and
booleans, matching what the `NodeChildren` type allows.

### Fixed — tag factories read inherited props

A props object created with `Object.create(defaults)`, or a class instance, had
its inherited `class`, `on`, `style`, attributes and `onElement` applied as if
the caller had passed them. Props, and the class, style and event maps, are now
read by own keys only. The common plain object pays a single prototype check.

### Fixed — lifecycle hooks registered before `<body>` existed

The shared lifecycle observer watched `document.body`. A classic script in
`<head>` registering `onMount()` / `onUnmount()` threw, and the observer was
recorded as installed anyway, so every later hook watched nothing; a replaced
`<body>` was never observed either. It now watches the document element, and is
recorded only once observing succeeds.

### Changed — default CDN budget baselines

The gzip baseline is raised from 26,600 B to 27,200 B: making `mount()`
transactional brings `withDisposerRollback()` into the default bundle
(+276 B), the marker-checked fragment unmount and contained DevTools emits add
179 B, and the render-transaction and own-key work above adds 192 B. The raw
budget, unchanged until now, rises from 80,202 B to 81,000 B for the same work.

## [4.6.0] — 2026-09-18

### Changed — internal render-transaction helpers are no longer exported from `sibujs`

The root barrel re-exported every symbol of the disposal and id modules, so
helpers added for the framework's own render transactions became public API:
`withDisposerRollback`, `currentDisposerCapture`, `beginDisposerCapture`,
`endDisposerCapture`, the `DisposerCapture` type and `idSegment`. An unpaired
`endDisposerCapture()` can corrupt an open transaction, so these are now exported
explicitly from their source modules for internal use only. The public disposal
and id surface — `dispose`, `registerDisposer`, `unregisterDisposer`,
`replaceChildrenSafely`, `checkLeaks`, `MAX_DRAIN_TEARDOWNS`,
`reportDrainRunaway`, `createId`, `__resetIdCounter` — is unchanged.

### Fixed — `defineElement()` re-rendered recursively when a component wrote its host's attributes

A component that set one of its own observed attributes while rendering started a
nested render from `attributeChangedCallback`, recursing until the stack
overflowed. Attribute changes during a render now trigger one follow-up pass after
it commits, unchanged values are ignored, and a component that changes its own
attributes on every render is stopped after 10 passes and reported. A first render
that throws is also retried on the next attribute change instead of leaving the
element blank until it is reconnected. A component that moves its host while
rendering gets one follow-up render instead of a nested one, and one that removes
its host has that render rolled back as a failed transaction — releasing what it
registered on the returned tree, on intermediate nodes and on the host itself —
rather than committed into a disconnected element nothing would tear down.
Disconnecting normally now also releases disposers registered directly against
the host, not only those inside the rendered subtree — the host's own teardowns
only, so a shadow element's light-DOM (slotted, consumer-owned) children keep
their reactive lifecycle. A teardown that reconnects the element renders the next
generation after every teardown has finished draining — counted, so a nested
disconnect inside a teardown cannot release the outer one early — so the new
generation's host-owned work is not torn down by the old one. An observed
attribute written by a disposer defers its render the same way. A re-render whose
teardown of the previous subtree disconnects the host (a disposer that removes
it) no longer installs the new generation into the disconnected element, half
released by that disconnect and half live; the commit is abandoned, and a
reconnect renders a fresh generation.

### Fixed — a failed render rolled back cleanup that belonged to unrelated effects

`withDisposerRollback()` recorded every disposer registered while a build ran,
including those registered by effects the build's signal writes re-ran elsewhere
on the page, so a failed render tore down live bindings it did not own. Every
subscriber now remembers the render transaction it was created in: its re-runs
register into that transaction (and roll back with it), and a subscriber created
outside one never registers into whatever transaction happens to be open. A
nested transaction that succeeds hands its subscribers to the enclosing one, so
an ancestor's failure still rolls back cleanup they register afterwards; once the
outermost one finishes, later re-runs are captured by nobody. A finished frame
also drops its own list, so a long-lived effect cannot retain the nodes and
teardowns of the render it was created in.

### Fixed — plugin hooks and providers registered after `install()` were lost

The staged install context kept writing to its staging area after the commit, so
`ctx.provide()` / `ctx.onMount()` called from an init hook, an async install or a
timer never reached the registry. Once committed, the context writes to the live
registry again; an init hook registered by an init hook is recorded but not run in
the same pass.

`install()` may now return a promise (`void | PromiseLike<void>`), and `plugin()`
returns it: an async install commits only when it fulfils — everything registered
before and after an `await` commits together — while a rejection commits nothing,
is reported with `phase: "async"` and leaves the plugin installable again. The
name stays reserved while the install is in flight, so a concurrent attempt is
refused, and ignoring the returned promise never produces an unhandled rejection.
The singleton `plugin()` returns that promise too, so applications using the
default registry can await readiness or catch a failed install.

`registry.reset()` is now terminal for everything issued before it: an install
still in flight cannot commit, a context retained by an already-installed plugin
stops writing to the registry, and the same plugin name can be installed again
immediately — an older installation settling afterwards cannot disturb it. A
cancelled installation rejects with the new `PluginInstallCancelledError` rather
than reporting success it never achieved (a synchronous install that resets its
own registry throws it); the cancellation is deliberate, so it is not reported as
a runtime error. That error is branded with a global symbol and exported
alongside `isPluginInstallCancelledError()`, so a cancellation raised by one copy
of the module is recognised by another's `instanceof` — the default registry is
shared across duplicate copies. An install that resets the registry itself never
reserves its name, so the name stays installable even if that installation never
settles. Recursion protection is independent of `reset()`: a plugin that resets
the registry from inside its own `install()` still cannot install itself.

### Fixed — ISR stopped revalidating after one failed fetch

A failed revalidation (including the initial fetch) now keeps the data stale and
retries after `revalidateAfter`, instead of never refreshing again.

### Fixed — `TransitionGroup.remove()` rejected on a failing `leave`

A throwing or rejecting `leave` is now reported with the element (like `add()`
and `track()`), `remove()` resolves, and the element is removed from the group so
a later `track()` does not run `leave` for it again.

### Fixed — accessibility checks reported false positives

`checkKeyboardAccess()` no longer flags a container whose click listener only
delegates to its own controls — declared with `data-a11y-delegates` or the new
`delegatesActivation` option, never inferred from the descendants, so a clickable
card wrapping a button is still reported — and treats `summary` as natively
interactive. `checkFormLabels()` finds a
`<label for>` anywhere in the input's document or shadow root, so checking an input
directly no longer reports it as unlabeled.

### Fixed — `createHttpMock()` gaps in jsdom and with abort reasons

A `FormData`, `URLSearchParams` or `Blob` from another realm (jsdom's classes with
the runtime's `Request`) reaches the handler readable instead of as
`"[object FormData]"`: a body the runtime rejects or stringifies is passed
through as-is with a `Content-Type` describing it (an explicit one from the
caller is kept), while a body the runtime understands keeps decoding exactly as
the same bytes in a `Request` input would. A body on a GET or HEAD request is
refused on that path too, as `fetch()` does. An abort rejects with
the signal's reason — a `TimeoutError`, or a custom value — like `fetch()`.

### Fixed — `swipe()` lost gestures

A single touch that starts while an earlier touch is still tracked (its
`touchend` was missed) now starts a new gesture instead of being dropped, and only
touches on the target element count toward the multi-touch check, so a finger
resting elsewhere no longer blocks swipes.

### Fixed — `urlState()` pushes copied scroll-restoration identity

A pushed entry carries the current `history.state` forward without
`scrollRestoration()`'s `__sibuScrollKey`, so two entries no longer share one
identity and restore the same position. Replaced entries and an explicit `state`
are unchanged.

### Fixed — smaller gaps

- `Head({ title: null })` and `renderToDocument({ title: null })` no longer render
  the literal title "null".
- `migrate()` reports a stored version the strict SemVer parser rejects (for
  example `"1.0.0.1"`) in `errors` and runs nothing, instead of rejecting.
- `datePicker`, `tooltip`, `popover`, `select` and `combobox` teardowns are
  idempotent: calling an old teardown again after rebinding no longer undoes the
  new binding.

### Fixed — `transition()` stayed pending when reading a result's `then` threw

The body's result was checked with `result.then` outside any `try`, so a throwing
getter escaped the idle callback and `pending()` never returned to `false`. The
result is now adopted with `then` read exactly once and invoked in a microtask;
fulfillment, rejection, a throwing getter and a throwing invocation all settle the
start, and failures (including a throwing body) are reported with
`phase: "async"` and `name: "transition"`.

### Fixed — `socket()` opened a connection or heartbeat after reentrant disposal

A status subscriber closing or disposing the socket while `"connecting"` or
`"open"` was published did not stop the interrupted code: a replacement
`WebSocket` was still constructed, or a heartbeat started. `close()` now
invalidates the lifecycle, which is rechecked after each status publication and
around socket construction; a socket created for an invalidated lifecycle is
closed immediately. The lifecycle is captured before the URL getter runs, every
invalidated path leaves the status `"closed"`, and a throwing URL getter is
reported (status `"closed"`) instead of escaping the constructor or reconnect
timer. The same applies when the `WebSocket` constructor itself throws (a URL the
browser rejects, invalid or duplicate protocols, CSP or policy blocks); such a
failure does not schedule a reconnect.

### Fixed — `imageLoader()` could continue a load interrupted by disposal

`start()` published `"pending"` and then created an `Image` unconditionally. Each
start now carries a token and stops if the loader was disposed or a newer start
began during that publication; abandoned requests are always aborted and
detached.

### Fixed — reentrant `globalStore` dispatches delivered states out of order

A listener that dispatched or reset during a notification had the newer state
delivered first and the rest of the older round afterwards, so listeners saw
history backwards, and a listener handling one state could read a newer one from
`getState()`. Store operations are now queued: a `dispatch()` or `reset()`
requested while another is running (from a listener, middleware or action) runs
after the current one has committed and delivered, so every listener's state
equals `getState()` and rounds arrive in commit order. The caller's own failing
action still throws; a queued one that fails is reported. Subscriptions are
tracked as records, so a callback unsubscribed and re-subscribed during a round
starts with the next update; subscribing an already-subscribed callback still
returns the existing subscription. A middleware `next()` called after the
middleware has returned (from a timer, a promise or after an `await`) re-enters
the same queue, and an error from such a delayed continuation is reported.
Middleware may be `async` (`Middleware` now returns `void | PromiseLike<void>`):
a rejection is reported with `phase: "async"` and
`name: "globalStore(middleware)"`, and a middleware that throws or rejects before
calling `next()` never continues, so an action whose dispatch failed cannot run
later. The queue drains with a cursor, so a large reentrant burst stays linear.
Listener isolation is unchanged.

### Fixed — `select()` Home/End highlighted disabled options

Home and End jumped to the literal first and last options. They now move to the
first and last enabled option (and leave the highlight alone when every option is
disabled), and `aria-activedescendant` never identifies a disabled option, even if
the disabled predicate changes after highlighting.

### Fixed — `gamepad()` kept disconnected and replaced controllers

When the last controller disconnected, polling stopped without publishing, so
`pads()` kept reporting it as connected. Snapshot comparison also ignored the
device `id`, so a different controller at the same index with identical inputs
kept the previous identity. Disconnection now publishes the remaining set before
polling stops, and snapshots compare `id`. Disposal is terminal: a `pads()`
subscriber disposing during a frame, or a stale frame firing afterwards, can no
longer restart polling.

### Fixed — `infiniteQuery` fetches mutated state after `dispose()`

`refetch()` cleared the pages before the fetch noticed the query was disposed,
leaving `pages()` empty while the disposed `data()` kept its last value.
`refetch()`, `fetchNextPage()` and `fetchPreviousPage()` are now no-ops after
disposal.

### Fixed — `copyOnClick` leaked clipboard failures as uncaught errors

The clipboard write's promise was discarded, and a missing Clipboard API or a
throwing text getter threw from the raw click listener. Every failure is now
reported through the runtime error handler with `phase: "async"`,
`name: "copyOnClick"` and the element as `node`.

### Fixed — dynamic components registered through one package copy were not found through another

`registerComponent()` used a module-local map, so with duplicated SibuJS copies a
component registered through one could not be resolved through the other. The
registry is now shared through a versioned global symbol, like the action and
reactive registries.

### Changed — default CDN gzip budget baseline

The baseline was raised from 26,450 B to 26,500 B for the `copyOnClick` and
component-registry fixes (+64 B after trimming), to 26,600 B for safe thenable
adoption in `transition()` and the `imageLoader` reentrancy guard (+106 B), and
to 26,800 B for per-subscriber render-transaction ownership in the disposal and
reactive core (+111 B), and back to 26,600 B once the internal transaction
helpers stopped being re-exported from the root barrel (−250 B); the raw budget
is unchanged.

### Fixed — `springSignal()` restarted after disposal and crashed during SSR

`dispose()` had no terminal state: a later `set()` started the animation again,
and a subscriber disposing the spring during a frame still got another frame
scheduled. Disposal is now terminal — `set()` does nothing, a frame checks it on
entry and again after publishing before rescheduling, and repeated disposal is
safe. Without `requestAnimationFrame` (SSR, bare Node) the setter snaps to the
target, like reduced motion, instead of throwing.

### Fixed — `stream()` accepted events from closed, disposed or replaced sources

EventSource handlers never checked whether they still belonged to the live
connection, so a closed or disposed stream could report `"open"` again or publish
late data, and an old source's `onerror` could act on its replacement. Every
handler now ignores events unless its source is the current one and the stream is
not disposed, and `close()` detaches the handlers before closing the source.
Closing or disposing from a status subscriber is also safe: a `"connecting"`
subscriber prevents the replacement connection from being created, a `"closed"`
subscriber prevents the reconnect timer, and `close()` always publishes
`"closed"`.

### Fixed — `TransitionGroup` dropped rejected async callbacks

`enter` and `leave` may return promises, but their rejections became global
unhandled rejections, and a synchronous throw from any callback aborted `track()`
part-way. Every callback now runs isolated: throws and rejections are reported
through the runtime error handler with the element as `node`, and the remaining
elements are still processed. A returned thenable's `then` is read exactly once
and invoked in a later microtask, as native promise assimilation does.

### Fixed — `form.handleSubmit()` swallowed submit failures

A rejected async submit reset `submitting` but discarded the error, so a failed
save looked successful. Synchronous throws, rejections and thenables whose `then`
throws are now reported with `phase: "async"` and `name: "form.handleSubmit"`,
and `submitting` is always released. A returned thenable's `then` is read
exactly once, so a stateful accessor cannot skip the adoption, and it is invoked
only after `submitting` is raised, so a synchronous thenable cannot re-enter the
submit handler. **Behavior change:** a synchronous throw from the submit callback
is reported instead of propagating to the caller.

### Fixed — failed-render rollback left cleanup registered during rollback attached

`withDisposerRollback()` stopped capturing registrations before running the
captured teardowns, so a teardown that registered more cleanup left it attached to
nodes the failed render never returned. Capture now stays open while rolling back
and the queue is drained to stability (newest first), bounded by the same teardown
ceiling as `dispose()` and reported when reached. Nested transactions and
teardowns that both throw and register cleanup are covered. Cleanups that a
`dispose()` already ran during the build are neither run again by the rollback
nor handed to an enclosing transaction.

### Fixed — adapted components ignored positional children

Components from `componentAdapter()` accepted only a props object, so
`Button({ variant: "primary" }, "Save")` rendered an empty button. They now take
children positionally like every tag factory; positional children take precedence
over `nodes`.

### Fixed — the adapter theme never reached its components

`setTheme()` updated a signal that no component read, so `classOverrides` and
`prefix` had no effect. Component classes are now reactive: `<Component>`,
`<Component>-<variant>` and `<Component>-<size>` overrides replace the matching
classes, a prefix change re-prefixes the mapping's classes, user classes are kept,
and existing components update. The new `theme.applyTo(root)` installs the theme's
CSS variables on a root element, keeps them in sync, and returns a release function.
Handles may overlap on one root and be released in any order: each property keeps
one layer per handle, the most recently applied live layer wins, and once no layer
sets it the value and priority the element had before are restored.

### Fixed — `createHttpMock()` diverged from `fetch()`

- A `Request` input is read like `fetch()` reads it: method, headers, body (from a
  clone, so the caller's request stays unconsumed) and signal, each overridable by
  `init`.
- Handlers receive the same body type for equivalent requests, whether the body
  came from `init` or a `Request`: multipart → `FormData`, form-encoded →
  `URLSearchParams`, text and JSON types → parsed JSON or the string, anything
  else (binary, untyped) → `Blob`. Every call is normalized into one effective
  `Request` built exactly as `fetch()` builds it (a `Request` input is cloned and
  `init` overrides it), so method, headers and body always agree: `init.headers`
  supersedes the `Request`'s own, an explicit content type decides how the body
  is decoded, and handlers see the `Content-Type` `fetch()` generates for
  `FormData` (with boundary), `URLSearchParams` and typed `Blob` bodies.
- Relative URLs resolve against the page location when it is an http(s) URL, and
  against `http://localhost` otherwise (for example jsdom's default
  `about:blank`), instead of rejecting with "Invalid URL".
- Abort signals are honoured: an already-aborted signal rejects immediately, and an
  abort during a handler or `delay` rejects with an `AbortError` instead of
  resolving later. As in `fetch()`, an input `Request`'s signal is inherited
  when `init.signal` is omitted or `undefined`, and an explicit `signal: null`
  detaches from it.
- String routes match exactly. A path route compares the request's pathname (plus
  its query when the route has one), and an absolute route the full URL;
  `"/api/users"` no longer matches `https://host/evil/api/users`.

### Fixed — DOM snapshots and fingerprints could collide

`createDOMSnapshot()`, `assertDOMEquals()`, `snapshotComponent()` and
`captureFingerprint()` interpolated attribute values and text raw, so an attribute
`a='x" b="y'` serialized exactly like two attributes, and text `<span>` like an
element. Attribute values, text and comments are now escaped.

### Fixed — test selector builders produced invalid or widened selectors

The Cypress `commands` and Playwright `selectors` builders interpolated values raw.
Quotes, backslashes and newlines are now escaped, so every value yields a valid
selector that matches exactly that value.

### Fixed — accessibility checks skipped the root element

Every check used `root.querySelectorAll()`, which never includes the root, so
running `checkA11y()` directly on an input, image, button or `<main>` passed or
misreported. The root is now checked along with its descendants, once.

### Fixed — keyboard checks missed framework event handlers

`checkKeyboardAccess()` only saw `onclick` attributes, never `on: { click }`.
Loading the testing utilities now enables listener tracking (also available as
`enableListenerTracking()`), which records element listeners below the framework —
tag factories, `html` templates and `addEventListener` alike, in development and
production builds. It follows DOM listener identity — `(type, callback, capture)`,
duplicates counted once — and forgets `once` listeners after they fire and
`signal` listeners when the signal aborts. The check treats click and pointer listeners as activation and
key listeners as keyboard support. The core bundle carries no tracking code.

### Fixed — visual fingerprints ignored computed styles

A stylesheet-only change produced an identical fingerprint. Fingerprints now carry
`computedStyles`, the appearance-relevant computed properties of every element,
which feed the hash and are reported by `compareFingerprints()` as `"computed"`
changes.

### Fixed — `VERSION` reported a version the package never had

`VERSION` from the versioning plugin was hard-coded to `"1.0.0"`, so compatibility
checks compared against a false framework version. It is now the published package
version, stamped at build time.

### Fixed — `rollback()` could reverse steps before finding an irreversible one

A missing `down()` was discovered only when the rollback reached it, after newer
steps had already been reversed. Every step is now checked for a `down()` before
any is run, so an irreversible migration fails the rollback without changing
anything. Combined with the per-step checkpoints, storage always describes what is
actually applied.

### Fixed — route loader data leaked between routes and SSR requests

Loader data lived in one application-global context: every `executeLoader()`
replaced it, nothing restored it, and disposal left it discoverable, so a route's
component could read another route's data and concurrent SSR requests saw each
other's. There is no ambient loader any more: `loaderData()` resolves only inside
the new `renderWithLoader(resource, render)`, which scopes the data for exactly
the duration of a route component's construction (scopes nest, and the previous
one is restored even if rendering throws). `withLoader(loader, context, render)`
executes and renders in one step, disposing the resource if rendering throws. A
disposed resource cannot be read or scoped. Scopes are per SSR request.

**Breaking:** calling `loaderData()` after `executeLoader()` without
`renderWithLoader()` / `withLoader()` now throws.

### Fixed — `createListbox()` activated and selected disabled options

Options marked `aria-disabled="true"` (or `disabled`) were reachable by arrow keys,
Home and End, and selectable by Enter or click. Navigation now skips them (with
wraparound), selection and clicks refuse them, `aria-disabled` is read live so a
change takes effect immediately, and an all-disabled listbox has no active option.

### Fixed — concurrent `clipboard().copy()` calls published in completion order

Writes can settle out of order, and every write that resolved updated `text()` and
replaced the `copied` reset timer, so an older copy finishing late overwrote the
newer value. Only the most recent `copy()` now publishes state or owns the timer;
a superseded write still resolves (or rejects) for its own caller, and `dispose()`
invalidates every pending write.

### Fixed — `socket().close()` after a remote close reported `"closing"` forever

The native close handler never released the closed socket, and closing a `CLOSED`
socket fires no further event, so `status()` stuck at `"closing"`. The handler now
releases its instance, `close()` inspects `readyState` (a closed socket stays
`"closed"`, a closing one is left alone), and every handler ignores events from a
socket that has since been replaced by a reconnect.

### Fixed — single-file `fileUpload()` reported files it did not keep

In single mode only the last valid file is retained, but `onFiles` received every
valid file, so consumers processed files the widget had discarded. `onFiles` now
receives exactly the committed selection.

### Fixed — empty `accept` tokens admitted files of unknown type

A trailing or doubled comma (`"image/png,"`) produced an empty pattern that equalled
a file's empty MIME type, letting any file of unknown type through. Empty and
whitespace-only tokens are now dropped; an `accept` string with no valid tokens
applies no restriction, like the HTML attribute.

### Fixed — `formatCurrency()` options could override currency and style

Options were spread after `style: "currency"` and `currency`, so
`{ currency: "EUR" }` or `{ style: "percent" }` defeated the positional currency.
The fixed fields are now applied last, and options are typed as the new
`CurrencyFormatOptions` (`Intl.NumberFormatOptions` without `style` / `currency`).

### Fixed — resource hints were deduplicated by URL alone

`prefetch()` and `preloadResource()` shared one URL-keyed cache, so a prefetch
suppressed a later preload of the same URL, and one `as` value suppressed another.
Hints are now deduplicated by `rel`, `as`, `crossorigin` and URL together; exact
duplicates are still created once.

### Fixed — Tabs and Accordion generated duplicate document ids

Element ids were derived from the caller's item id alone, so two widgets with the
same item ids both created `sibu-tab-details` / `sibu-tabpanel-details` (and the
accordion equivalents): `aria-controls` and `aria-labelledby` resolved to another
widget's elements, and item ids containing whitespace produced multi-token ARIA
references. Each `bind()` now allocates a unique prefix with `createId()` and
appends an encoded, collision-free form of the item id; ids the author already set
on the elements are kept and referenced as-is, and teardown removes only generated
ids.

### Fixed — datePicker teardown left cell accessibility state behind

`bind()` wrote `role`, `aria-selected`, `aria-disabled` and `tabindex` to every
cell, but teardown restored only the grid, so reused cells kept `role="gridcell"`,
stale ARIA state and a roving tabindex. Each cell's original attributes are now
captured on first touch; cells that leave the displayed month are restored
immediately, and teardown restores the rest.

### Fixed — `draggable()` permanently changed relinquished elements

Retargeting and disposal removed only the listeners: the previous element stayed
`draggable`, and `isDragging()` could stay `true`. The element's original
`draggable` attribute is now restored on retarget and disposal, `isDragging` is
cleared when the active target is detached, and `dispose()` is idempotent.

### Fixed — `dropZone()` flickered while moving between child elements

Every bubbling `dragleave` cleared `isOver`, including the one fired when moving
from one child to another inside the zone. Enter/leave events are now balanced
with a depth counter, and the state resets on drop, retarget and disposal. A leave
to a known node outside the zone (including another document) ends the hover
outright. A leave with no destination — which Safari reports for every drag leave,
including moves between children — ends it only if no `dragenter`/`dragover` on
the zone follows within 600 ms, so the hover neither sticks after leaving the
window nor flickers off inside the zone.

### Fixed — `pointerLock().request()` discarded the browser's result

Modern `requestPointerLock()` returns a promise that rejects on refusal, but the
wrapper ignored it, so permission and user-activation failures became unhandled
rejections. `request()` now returns `Promise<void>`, resolving when the lock is
granted and rejecting with the browser's original error; synchronous throws and
legacy `void` implementations are normalized. An element without Pointer Lock
support (e.g. iOS Safari) resolves without doing anything, so fire-and-forget
callers never get an unhandled rejection.

### Fixed — `throttle()` emitted twice in quick succession after a trailing update

A trailing emission ended the cooldown, so a change 1 ms later emitted
immediately — two updates back-to-back despite "at most once per interval". Every
emission, leading or trailing, now opens a full cooldown window.

### Fixed — `withDefaults()` made every prop optional

It returned `Component<Partial<P>>`, so a required prop without a default could be
omitted and arrive as `undefined`. The returned component now takes
`WithDefaultsProps<P, D>` (exported): keys with a default become optional, all other
keys keep their original required/optional status, and defaults for keys the
component does not accept — or of the wrong type — are compile errors.

### Fixed — `interval().pause()` did not preserve the remaining delay

`pause()` cleared the interval and `resume()` started a fresh full period,
contradicting the documented contract and drifting on every pause. `resume()` now
finishes the interrupted period first, then continues on the regular cadence; time
spent paused does not count. `pause()` and `resume()` are idempotent, and `stop()`
leaves nothing scheduled.

### Fixed — `swipe()` combined different touches and ignored cancelled gestures

The end of a gesture was read from `changedTouches[0]`, so an unrelated finger
could complete it, and `touchcancel` was ignored. A gesture is now tracked by the
initiating touch's `identifier`: its end is matched by identifier, `touchcancel`
ends it, and a gesture that becomes multi-touch is abandoned. `dispose()` also
removes the new cancel listener.

### Fixed — disposing one `speech()` controller cancelled every controller's speech

Controllers called the global `speechSynthesis` `cancel()` / `pause()` / `resume()`
directly, so unmounting one component cancelled or paused speech from every other
controller and from application code. Utterances from all controllers now go
through a shared owner-aware queue and are handed to the native queue one at a time.
`cancel()`, `pause()`, `resume()` and `dispose()` affect only that controller's
utterances, and native methods are called only while its utterance is the one
speaking. `speaking()` now means "this controller has an utterance playing or
waiting", and the 200 ms state polling is gone.

### Fixed — a failed `scrollLock().lock()` corrupted the shared lock count

Ownership and the shared count were committed before the body styles were applied,
so a lock that threw (no `document.body` yet, a failing style write) left the count
at 1 with no handle able to release it, and every later lock skipped the body. The
DOM work now runs first, all-or-nothing, and ownership is committed only after it
succeeds.

### Fixed — `Head({ title: "" })` could not clear the title

The static title path tested truthiness, so an empty title was ignored while a
reactive getter returning `""` worked. Both now apply any defined title, and the SSR
document shell renders an empty `<title>` the same way.

### Fixed — `setStructuredData()` deleted valid JSON-LD before serializing

The existing script was removed before `JSON.stringify` ran, so a payload that fails
to serialize — a cycle, a `BigInt`, a throwing getter or `toJSON` — destroyed the
previously published metadata. The replacement is now built first and swapped in
place with `replaceWith()` only after serialization succeeds.

### Fixed — `createId()` was not request-scoped during SSR

The suspense counter was request-scoped but `createId()` incremented one
process-global counter, so a server render's ids depended on earlier and
concurrent requests and could differ from a fresh client's — breaking `for`,
`aria-labelledby`, `aria-describedby` and hydration. Inside `runInSSRContext` the
counter now lives on the request store (shared by duplicate module copies through
the same request), so every request's ids start from 1 and match a fresh client
sequence. Outside a request the shared client counter is used as before.

### Fixed — module factories bypassed circular-dependency detection

A module left the resolution stack before its factory ran, and a factory calling
`resolve()` started a fresh stack, so a factory cycle recursed until the call stack
overflowed. Modules now move through `unloaded` → `resolving` → `loaded`, detected
across every `resolve()` call including those made from factories, so direct and
indirect factory cycles throw the documented circular-dependency error. A module
whose initialization throws returns to `unloaded` and can be retried; a successful
factory still runs once.

### Fixed — a failing custom-element rerender destroyed the working component

`defineElement()` tore the current subtree down before calling the component
factory, so a throwing rerender — typically an invalid attribute — left the element
blank with its live state disposed. Rendering is now a transaction: the replacement
is built first and committed only on success, disposing the old subtree exactly
once. On failure the working subtree stays, disposers the failed attempt registered
are rolled back, and the error is reported with the element as its node
(`phase: "render"`), so an enclosing `ErrorBoundary` can claim it.

### Fixed — router parsing dropped `?` and `#` after the first one

Route parsing destructured `split("#")` and `split("?")`, keeping only the first two
pieces: `/callback?redirect=/login?next=home#section#details` lost `?next=home` and
`#details`. URLs are now split at the first `#`, then the first `?` before it, and
everything after a delimiter belongs to that part — for `navigate()` and for
`RouterLink` active-state matching alike.

### Fixed — testing utilities detached components without disposing them

The Jest and universal adapters cleared containers with `innerHTML = ""`,
`testComponent().destroy()` removed its container directly, and
`snapshotComponent()` never disposed its temporary render, so effects, listeners and
subscriptions leaked across tests. All of them now run framework disposal first;
`snapshotComponent()` does so even when serialization throws. The Cypress adapter's
`mount()` now returns an idempotent, disposal-aware `unmount()`.

### Fixed — the fake timer turned zero-delay intervals into one-shot timers

`createTimerMock()` decided a timer was an interval by the truthiness of its period,
so `setInterval(fn, 0)` ran once — and `advance()` could spin forever on a zero
period. Interval kind is now checked explicitly, zero, negative and non-finite
periods are normalized to a 1 ms minimum so they stay recurring, and `flush()`
reports hitting its iteration limit instead of stopping silently.

### Fixed — `getSlot()` returned inherited members as slots

`getSlot({}, "toString")` returned `Object.prototype.toString`, so reserved-looking
slot names bypassed fallback rendering. Only an own, function-valued entry is now
returned.

### Fixed — `timeline()` accepted capacities that corrupted its state

`timeline(0, 0)` evicted the current value on the first `set()`, leaving an empty
history, an index of `-1` and an `undefined` value. `maxHistory` must now be a
positive safe integer; anything else throws a `RangeError`.

### Fixed — ISR `isStale()` did not react to time passing

`isStale()` compared a timestamp signal with `Date.now()`, so nothing reactive
changed when the deadline passed and subscribed UI stayed stale-unaware. Staleness
is now a signal flipped by a deadline timer: it becomes `true` when
`revalidateAfter` elapses (starting revalidation), stays `true` while revalidation
is pending or after it fails, and returns to `false` on success, which re-arms the
deadline. Disposal cancels the deadline, and a non-positive or non-finite
`revalidateAfter` throws a `RangeError`.

### Fixed — dynamically added listbox options had incomplete ARIA state

`createListbox()` stamped option ids and `aria-selected` only once, so options
inserted later had no id — keyboard navigation set an empty
`aria-activedescendant` — and no selection state. Options are now reconciled on DOM
mutation and before every interaction: new options get an id and `aria-selected`
reflecting the current selection, and removing the active option clears the active
descendant. The handle gains `refresh()` for synchronous reconciliation, and
`dispose()` stops observing.

### Fixed — `normalize()` permitted prototype pollution

The entity registry and tables were ordinary objects keyed by schema names and
ids, so a schema named `__proto__` wrote the normalized entity onto
`Object.prototype`, and ids such as `constructor` or `toString` collided with
inherited members that `denormalize()` then returned. `normalize()`,
`denormalize()` and `normalizedStore()` now keep their tables as null-prototype
objects, read only own properties, and define every write as an own property, so
every schema name, relation field and id is literal data.

### Fixed — normalized stores lost entities with missing ids and allowed re-keying

Ids came from `String(entity[idKey])`, so an entity without an id was stored
under `"undefined"` and each later one silently overwrote it. Ids are now
validated: only strings and finite numbers are accepted, and anything else throws
a `TypeError` naming the entity type and `idKey` — in `normalize()`, `add()` and
`addMany()`, where one invalid entity rejects the whole batch. An `update()` that
would change the entity's id field throws and leaves the store unchanged (remove
and re-add instead); repeating the same id is allowed.

### Fixed — `store()` could not hold an own `__proto__` state key

The signal registry and snapshots were filled by assignment, so a `__proto__` key
(valid in JSON) replaced the registry's prototype and disappeared from reads,
updates, resets, snapshots and `subscribeKey()`. The registry is now a
null-prototype object and entries and snapshot keys are defined as own properties.

### Fixed — `deepEqual()` treated distinct opaque objects as equal

After the handled built-ins it compared enumerable keys, so objects whose state is
not in enumerable keys — `new Number(1)` vs `new Number(2)`, two different `URL`s,
`Error`s with different messages — compared equal and `deepSignal` suppressed the
update. Boxed primitives now compare by value, `URL`s by `href`, and `Error`s by
name, message, cause and own enumerable fields. Only plain (or null-prototype)
records fall back to key comparison; any other distinct instance — a `Promise`, a
`WeakMap`, a class instance — is unequal.

### Fixed — reactive `splice(start)` ignored the missing `deleteCount`

`array()` and `reactiveArray()` defaulted an omitted `deleteCount` to `0`, so
`splice(2)` removed nothing, while native `splice(start)` deletes through the
end. Both now forward exactly the arguments given, matching
`Array.prototype.splice` for omitted and explicit `undefined` counts and for
negative or out-of-range starts. `array()` also no longer notifies for a
`splice()` that neither removes nor inserts anything.

### Fixed — prop defaults overwrote an explicit `null`

`validateProps()` (and so `defineStrictComponent()`) applied a default whenever
the value was `== null`, replacing an explicit `null` even when the prop's
validator accepts it. Defaults now apply only to absent or `undefined` props, in
both development and production. `false`, `0` and `""` were already kept.

### Fixed — `urlState()` erased `history.state` and instances drifted apart

- `setParams()` and `setHash()` passed `null` as the history state, silently
  erasing router metadata, scroll-restoration data and application state on the
  entry. The current `history.state` is now kept — on a replaced entry and carried
  onto a pushed one, falsy values included. The new `state` option in
  `UrlStateOptions` sets state deliberately.
- Setters updated only their own instance, and History API writes fire no
  `popstate`, so separately mounted `urlState()` instances disagreed about the
  URL. Every framework URL write now resynchronizes all live instances (shared
  across duplicate module copies); a disposed instance stops receiving updates,
  and `dispose()` is idempotent.

### Fixed — migration runner races, rollback checkpoints and loose SemVer parsing

- **Serialized operations.** `migrate()` computed its pending list before awaiting
  any migration, so concurrent calls ran the same `up()` twice. `migrate()` and
  `rollback()` now run one at a time across every runner in the realm sharing the
  same storage and storage key (runners on other keys stay independent), each
  re-reading the stored version when it starts; a failed operation releases the
  queue. The runner accepts a `storage` option (default `localStorage`).
- **Rollback checkpoints.** The applied version was written only after every
  `down()` succeeded, so a part-way failure left storage claiming reversed
  migrations were still applied and a retry ran their `down()` again. The version
  is now checkpointed after every successful `down()` (the key is removed when
  nothing remains applied).
- **Storage failures are distinct.** A failed storage write now surfaces as the new
  `MigrationStorageError` (with the migration's `version`) instead of being
  reported as a failed `up()` — `migrate()` lists it in `errors`, `rollback()`
  throws it.
- **Strict `parseSemVer()`.** It used `parseInt`, accepting `1.2.3garbage`,
  `1.2.3.4` and an empty prerelease. It now uses an anchored SemVer 2.0.0 grammar
  that rejects trailing characters, extra components, empty or illegal
  identifiers and numeric leading zeros, and parses build metadata into the new
  `SemVer.build` field. The `v` prefix and abbreviated `1` / `1.2` forms still
  work.

### Fixed — `eventBus()` and `createSharedScope()` did not isolate subscribers

Both iterated the live listener set and called user callbacks without
containment: one throwing listener stopped delivery to every later listener and
escaped to the caller, listeners added during delivery ran in the same dispatch,
and a listener that kept adding listeners never let it finish. Delivery now walks
a snapshot, isolates each callback and reports failures through the runtime error
pipeline (`phase: "event"`). Listeners added during a dispatch start with the next
one; listeners removed or cleared during it are skipped; a dispatch started from a
listener completes before the outer one continues. Delivery tracks subscriptions
rather than callbacks, so the same function unsubscribed and re-subscribed during
a dispatch also waits for the next one, and a stale unsubscribe handle no longer
removes a later subscription of the same callback.

### Fixed — startup caches exceeded their size bounds

`createSSRCache()` and `prerenderRoutes()` evicted before checking whether the key
already existed, so overwriting a key at capacity discarded an unrelated entry;
`maxSize: 0` still stored one item; an oldest key of `""` was never evicted; and
valid entries were evicted while expired ones remained. Overwrites no longer
evict, expired entries are removed before valid ones, `0` disables caching, and a
negative or non-integer limit throws a `RangeError`.

### Fixed — `deferNonCritical()` could starve forever

It scheduled `requestIdleCallback` without a timeout and, given a deadline with
under 1 ms left — which is always the case for a timed-out callback — rescheduled
without running anything. It now passes a finite timeout and runs at least one task
per callback, chunking the rest to the remaining idle budget. A failing task is
reported through the runtime error pipeline instead of `console.error`.

### Fixed — a synchronous `ssrSuspense()` content throw bypassed the fallback

`content()` was called as an argument to `Promise.race()`, so a synchronous throw
escaped `ssrSuspense()` and crashed the request, while an async rejection became
fallback output. Every failure to produce content HTML — a synchronous throw, a
rejection, a hostile thenable, the timeout, or rendering the resolved element
throwing — now resolves the boundary with the fallback HTML. A timer handle of
`0` is now cleared.

### Fixed — testing queries broke on attribute values with special characters

`queryByTestId`, `queryByRole` and `queryByLabel` interpolated values into CSS
selectors, so a quote, backslash, bracket or newline produced an invalid selector
or a wrong match, and a `findBy*()` whose query then threw on a later poll never
settled. Queries now match attribute values exactly via the new
`queryByAttribute()` / `queryAllByAttribute()` helpers — also used by `render()`,
the Jest/Cypress/Playwright adapters, the e2e helpers and the label check in the
a11y audit — and a throwing poll rejects the `findBy*()` promise.

### Fixed — `broadcast().post()` threw after `dispose()`

Disposal closed the native channel but `post()` kept calling it, throwing
`InvalidStateError`. After `dispose()`, `post()` is now a no-op and `last()` no
longer changes; `dispose()` is idempotent. Errors from `post()` before disposal,
such as a `DataCloneError`, still propagate.

### Fixed — failed plugin installation left a partially active plugin

`install()` wrote hooks and providers straight into the live registry, and the
plugin was marked installed only after `install()` returned. A throwing install
left its hooks and providers active while `installedPlugins` said it was not
installed; retrying registered every surviving hook again; and a plugin that
installed itself — directly or through a dependency — recursed until the stack
overflowed.

Installation is now a transaction. Hooks and providers are staged and committed
only when `install()` returns, so a failed install leaves the registry unchanged
and can be retried. The plugin is marked installed before its init hooks run.
Installing a plugin whose `install()` is already running throws a
recursive-installation error. Each `plugin()` call is its own transaction: a
dependency installed successfully by a nested `plugin()` call stays installed
even if the outer installation fails.

### Fixed — `lazyModule().get()` did not deduplicate concurrent loads

The cache was filled only after the loader resolved, so every `get()` made before
then started another load, with duplicated side effects and a cached value decided
by settlement order. Concurrent calls now share one in-flight load. A rejected
load clears the shared slot (only if it still owns it) so the next `get()`
retries.

`lazyModule()` now returns the new `LazyModule<T>` type, whose `loaded` is
`readonly` — assigning it compiled but threw at runtime, since it is a getter.

### Fixed — `packageInfo` described a package layout that does not exist

It reported `name: "sibu"`, `version: "1.0.0"`, `.mjs` import targets, source
paths that do not exist and subpaths the package does not export. It now reports
`sibujs` with the version stamped at build time, lists the real module entry
points, and `generateExportsMap()` produces exactly the `exports` map in
package.json — including the CDN subpaths, which map to `{ default }`. Its return
type is now `Record<string, PackageExportTarget>`. Tests fail if the entry list,
the build script and package.json drift apart, and check every target exists in
a built `dist`.

### Fixed — `contentEditable.setContent(string)` kept raw HTML

The string form is documented as `{ html, sanitize: true }` but stored the string
unchanged, so `content()` rendered as HTML carried live markup. It is now
sanitized exactly like `{ html }`. Any `<` that would open a tag after stripping
is re-escaped, so HTML-encoded payloads (`&lt;img onerror=…&gt;`) cannot decode
into markup, while intentionally encoded text is kept rather than deleted.
`{ html, sanitize: false }` remains the only raw-HTML path.

### Fixed — scoped `contentEditable` formatting unwrapped DOM outside the editor

The selection was checked to be inside the editor, but the search for an existing
wrapper kept climbing past it, so `bold()` / `italic()` / `underline()` could
unwrap an element that contained the editor and rewrite unrelated siblings. The
search now stops at the bound editor and at the nearest editing host
(`contenteditable` other than `"false"`); neither the boundary nor anything above
it is ever unwrapped.

### Fixed — `formAction().onSubmit` was typed for every action

`onSubmit` passes exactly one `FormData`, but it was on every handle, so a numeric
or multi-argument action compiled as a submit handler and received a `FormData`
at runtime. `FormActionHandle` now includes `onSubmit` only when a single-FormData
call is valid for the action; the shared members are `FormActionState`, and
`onSubmit` is `FormActionSubmit`. This is a type-level change for code that read
`onSubmit` on a non-FormData action.

### Fixed — `accordion()` and `tabs()` accepted invalid initial state

- `accordion()` now drops unknown `defaultExpanded` ids and, in single mode, keeps
  only the first valid one.
- `tabs()` uses `defaultTab` only when it names an enabled tab; otherwise the first
  enabled tab is active, and when every tab is disabled no tab is active (`""`).

### Fixed — widget `bind()` teardown did not restore mutated DOM

Tabs and Accordion toggled each panel's `hidden` without restoring it and deleted
author-written `aria-selected`, `tabindex` and `aria-expanded`, and FileUpload
overwrote the input's `accept` and `multiple`, the error region's text and the drop
zone's `data-drag-over`. Teardown now restores every attribute a binding touches to
its value before `bind()` — removing attributes that did not exist — and the
teardown functions are idempotent. Tabs also reconciles `aria-disabled` with each
tab definition in both directions while bound.

### Fixed — a middleware calling `next()` twice ran the action twice

Every `globalStore` middleware shared one `next` closure over a single chain
index. A middleware that called `next()` twice applied the action twice — one
`dispatch()` incremented a counter by two and notified listeners twice — and
with several middlewares the second call jumped straight to the action,
bypassing the middlewares after it.

Each middleware now receives its own `next`, which advances the chain at most
once per dispatch. Extra calls are ignored, with a development warning naming the
middleware and action. A middleware that fails (throws, or rejects) before calling
`next()` never continues — including when it queued `next()` in a microtask and
then returned an already-failing thenable — a rejected promise, a `then` accessor
that throws, a custom `PromiseLike` whose `then` rejects synchronously or throws,
or one that resolves to any of these at any depth — which previously ran the
action before the failure was observed. A non-native `then` that reports nothing
synchronously is pending: a rejection it delivers later, even for a state it
already held (a promise wrapper, a subclass overriding `then`, another realm's
promise), keeps the committed action and is reported.

### Fixed — `componentAdapter()` and `createTheme()` resolved inherited keys as classes

A `variant` or `size` named after an `Object.prototype` member (`toString`,
`constructor`, …) resolved to that member instead of a mapped class, and the
component threw while building its class. `resolveClass()` could likewise return
an inherited member from `classOverrides`. Variant, size and override lookups now
read own string entries only.

### Fixed — a throwing `globalStore` listener broke `dispatch()` and `reset()`

Both committed the new state and then iterated the live listener `Set` without
isolation. One throwing listener made `dispatch()` / `reset()` throw even though
the mutation had landed, and every later listener missed the update. Iterating
the live `Set` also delivered the current update to listeners subscribed during
notification, so a listener that subscribed on every call kept iteration from
terminating.

Both paths now share one notifier that delivers to a snapshot of the listeners,
isolates each call, and reports failures through the runtime error pipeline
(`phase: "event"`). Listeners subscribed during notification start with the next
update; listeners unsubscribed by an earlier listener in the same round are
skipped.

### Fixed — `machine.send()` lost reentrant events

Exit hooks and transition actions ran before the outer transition committed its
state. A `send()` from an action, an exit or entry hook, or a subscriber woken by
the context update saw the old state: its transition was overwritten when the
outer one finished, and exit hooks could run twice for one logical state.
Context and state were also published separately, exposing the new context
paired with the old state.

`send()` is now run-to-completion. Each machine has an internal FIFO event
queue; an event sent while a transition is in progress (exit → action → publish
→ entry) is processed, in order, after that transition completes — including
events sent from the initial state's entry hook. Context and state are published
in one batch. If a transition throws, the error still reaches the caller, the
processing guard is reset, and the events queued by that failed transition are
discarded. `send()` also no longer subscribes a calling effect to the machine.

### Fixed — `matchesPattern()` was nondeterministic with `g` / `y` expressions

The validator called `regex.test(value)` directly. A global or sticky expression
advances `lastIndex` on each match, so the same valid value alternated between
valid and invalid, and one validator shared by two fields marked the second
identical — and valid — field invalid, blocking submission.

Every validation now starts from `lastIndex = 0`, and the caller's `lastIndex` is
restored afterwards, so results no longer depend on call history and the
expression the caller passed in is left as it was.

### Fixed — `imageLoader()` exposed stale dimensions

Starting a new load reset `status` and `image` but not `width` / `height`, so
while a new reactive `src` was pending — and permanently if it failed — the
loader reported the previous image's dimensions, contradicting "0 until loaded"
and producing wrong aspect ratios. `dispose()`, documented to reset state, left
every signal unchanged.

- Starting a load now resets `status`, `image`, `width` and `height` together in
  one batch, and a successful load publishes them together too, so observers
  never see a mix of old and new values.
- `dispose()` resets every signal to its initial value, and is idempotent.
- An abandoned request that is still in flight — on a `src` change or on
  `dispose()` — is best-effort cancelled by clearing its `src`. An image that
  already loaded is left untouched, since a caller may still be displaying it.

### Fixed — `flushScheduler()` stranded remaining work when a task threw

`flushScheduler()` cancelled the pending frame / idle / timeout wake-up and then
invoked tasks without containment. The first throwing task escaped the flush,
and every task behind it stayed queued with nothing scheduled to run it, leaving
the application partially updated.

All scheduler drains — `flushScheduler()`, the frame/idle/timeout queue drain and
`Priority.IMMEDIATE` tasks — now invoke tasks through one shared safe path. A
failure is reported through the runtime error pipeline with
`phase: "scheduler"` (previously the async drain wrote straight to
`console.error`) and draining continues. Scheduler state is restored in a
`finally`.

### Fixed — `lazyChunk()` mounted components into disposed containers

`lazyChunk()` had no lifetime state and registered no disposer, so both
settlement paths always mutated the container. A container disposed before its
chunk loaded still called the component factory and appended the result — or
the failure message — after the disposal traversal had completed, leaving any
bindings and listeners the component created attached to an unreachable
subtree.

The container now registers terminal ownership before the load starts, as core
`lazy()` does. A container disposed before settlement never has the component
built or the failure message inserted, and a component whose own construction
disposes the container is disposed and discarded instead of appended.

### Fixed — overlapping `transition().start()` calls corrupted `pending()`

Every `start()` set `pending` to `true`, but each body reset it to `false` when
that one operation finished. With two transitions in flight, the first to
settle cleared `pending()` while the second was still running; a synchronous
first body cleared it before the second body had even started.

The transition now counts outstanding starts. Each one is released exactly once
— on synchronous completion, a throw, resolution or rejection — and `pending()`
becomes `false` only when none remain.

### Fixed — `intersection()` and `lazyLoad()` accepted callbacks from disconnected observers

`disconnect()` removes an observer's targets but does not clear entries it has
already queued, so the browser can still deliver a notification afterwards.

- **`intersection()`** — after `observe()` moved to another element, or after
  `unobserve()`, a notification queued for the previous observation overwrote
  the reactive `isIntersecting` / `intersectionRatio` state. Each observation now
  has a generation, and callbacks from a superseded one are ignored.
- **`lazyLoad()`** — a queued intersecting notification could call `loader()`
  after the returned cleanup ran, or call it a second time. It now has a
  terminal state: the loader runs at most once and never after cleanup.

Both also call `takeRecords()` before `disconnect()` to drop entries not yet
delivered.

### Fixed — `dispose()` was hidden from TypeScript on reactive helpers

`debounce()`, `throttle()`, `previous()` and `persisted()` retain effects, timers
and (for `persisted()`) a global `storage` listener, and their runtime values
always carried `dispose()` — but the declared return types were a plain getter
or tuple, so `value.dispose()` failed to compile without a cast.

- **New `DisposableAccessor<T>`** type (`Accessor<T> & { dispose(): void }`).
  `debounce`, `throttle` and `previous` now return it; it stays assignable
  wherever a plain getter was expected.
- **New `PersistedSetter<T>`** type. `persisted()` returns it as the setter, so
  `setValue.dispose()` type-checks. Its documentation now also states that the
  setter always carries `dispose()`, not only when cross-tab sync is on.

### Fixed — `animationFrame()` kept running after a reactive `pause()` / `dispose()`

Each frame published `delta` and `elapsed` — whose subscribers run synchronously
— and then unconditionally requested the next frame. An effect that called
`pause()` or `dispose()` in response flipped `running()` to `false`, but the
loop kept scheduling frames and publishing values indefinitely, breaking the
permanent-disposal contract with a full-speed browser loop.

The loop now tracks its state internally, independent of the `running` signal,
and re-checks it after every publication. A frame stops publishing and schedules
nothing once a subscriber pauses or disposes it, and never double-schedules when
a subscriber pauses and resumes it. `resume()` and `pause()` update internal
state before publishing `running`, so a subscriber reacting to it sees settled
state too.

### Fixed — `when()` and `match()` rendered after disposal

Both directives queue their first render in a microtask that checked only
`initialized` and `anchor.parentNode`. `dispose(anchor)` does not detach the
anchor, so a directive disposed before that microtask ran still invoked its
branch or case factory and inserted DOM after teardown — outside the disposal
traversal that had already completed, so the new branch's bindings and
listeners were never released.

Both now carry a terminal disposed flag, set by their registered disposer and
checked by the queued render and by `update()`. A directive disposed before its
first render never calls a factory and inserts nothing, matching `each()`.

### Fixed — `FocusTrap` threw from a microtask after disposal

`FocusTrap()` attaches its removal observer and performs autofocus in queued
microtasks. `dispose(trap)` does not detach the element, so a trap appended and
disposed before those microtasks ran was still connected, but its observer had
already been cleared: the queued `observe()` call threw an uncaught `TypeError`,
and autofocus moved focus into the torn-down trap.

The trap now has a terminal disposed state. Both microtasks return early once it
is disposed or no longer connected, so a disposed trap attaches no observer and
leaves focus where it was. Cleanup is idempotent — when the removal observer and
`dispose()` both reach it, focus is restored once — and the observer path also
releases the node's disposer registration.

### Fixed — manual helper disposal left dead cleanup registrations

`hover()`, `focus().bind()` and `createListbox()` register their cleanup with the
element and also return it for manual disposal, but the manual path never
removed the node-level registration. Every attach/dispose cycle on a long-lived
element left one dead closure behind: it kept its captured state alive,
`checkLeaks()` kept counting it, and the final `dispose(node)` re-ran every
historical cleanup.

Manual disposal now calls `unregisterDisposer()` — the pattern `enhance()`
already used — so repeated cycles return the active binding count to its
original value and `dispose(node)` runs only the cleanups still live. Each
disposer is idempotent, and calling it after `dispose(node)` is a no-op.

### Fixed — multi-select `createListbox()` lost values stored as CSV

Multiple selection lived in one comma-joined string that was re-split on every
toggle. Selecting an option whose `data-value` was `"a,b"` was indistinguishable
from selecting `"a"` and `"b"`, it could not be deselected, and later toggles
marked options the user never chose as `aria-selected="true"`. The empty-string
value was dropped by the split and could not be toggled at all.

### Added — `ListboxHandle.selectedValues()`

The listbox now stores its selection as a collection. `selectedValues()` returns
the selected values in selection order (at most one in single-select mode), and
toggling and `aria-selected` reconciliation work from it, so every `data-value`
string — including commas and `""` — is selectable and deselectable on its own.
An option without a `data-value` is never marked selected.

`selectedValue()` is kept as a compatibility view (the value in single-select
mode, the CSV in multiple mode) and is deprecated for multiple mode.

### Fixed — `dialog()` stack corruption under reentrancy and after `dispose()`

`open()` published `isOpen = true` before adding the dialog to the global stack.
Subscribers run synchronously, so an effect that closed the dialog as it opened
ran before the push, and `open()` then pushed an already-closed "ghost" entry:
the global Escape listener stayed attached, and after the real top dialog closed
the next Escape targeted the ghost. The mirror case — an effect reopening the
dialog as it closed — left it open but off the stack. `dispose()` had no
terminal state, so a stale `open()` or `toggle()` re-attached the controller.

`open()` and `close()` now commit the open state and stack membership before
publishing `isOpen`, so a reentrant call always sees settled state. `dispose()`
is terminal: it marks the dialog disposed before changing anything observable,
and `open()` / `toggle()` are no-ops afterwards. `isOpen()`, stack membership
and the global Escape listener stay in sync in every case. `open()`, `close()`
and `toggle()` also no longer subscribe a calling effect to `isOpen`.

### Fixed — a throwing transition callback hung `enter()` / `leave()`

`transition()` called `onEnterDone` / `onLeaveDone` and only then resolved the
promise, so a throwing callback skipped the resolve. With a timed transition,
`await enter()` or `await leave()` hung forever and the exception escaped from
`setTimeout`, bypassing `ErrorBoundary` and `setRuntimeErrorHandler`. With
`duration: 0` the promise rejected instead, so behaviour depended on duration.

The promise now always resolves. The callback's error is reported once with
`phase: "async"` and the element as its node, so the nearest `ErrorBoundary`
claims it, or the runtime handler when none does. Transition classes and timer
state are cleaned up as before, and the controller stays usable.

### Fixed — `resource()` ran `onSettled` after `dispose()`

`dispose()` blocked late `data`, `error`, `loading`, `onSuccess` and `onError`
updates, but `onSettled` was gated only on the request version, which disposal
does not change. When the aborted request rejected — or a fetcher that ignores
the abort signal eventually resolved or rejected — `onSettled` still ran against
a torn-down owner. No lifecycle callback runs after `dispose()` now; a request
that settles before disposal still gets its `onSettled`.

### Fixed — uncloneable payloads corrupted the worker controllers

`postMessage()` throws synchronously (`DataCloneError`) when a payload cannot be
structured-cloned — a function, DOM node, symbol or some proxies. None of the
worker APIs handled that, and each was left in a broken state:

- **`worker().post()`** set `loading` to `true` before posting, and nothing ever
  cleared it. It now posts first: a failed post sets `error()` to the original
  exception and leaves `loading` and `result` untouched, so a request already in
  flight is unaffected. When that request's reply arrives it clears the error
  together with setting `result` and `loading`, so the hook never shows a good
  result alongside another call's failure.
- **`workerFn().run()`** queued the request before posting. Replies are matched
  to requests by queue position, so the failed request absorbed the next reply
  and every later caller received its predecessor's result. The failed `run()`
  now rejects without ever entering the queue, and `loading` reflects only the
  requests actually sent.
- **`createWorkerPool().execute()`** left the worker's slot marked in flight with
  its listeners attached, so that worker's queue never advanced. The task now
  rejects, the slot is released, and the next queued task is dispatched.

The rejection or `error()` value is the original `DataCloneError`, so callers
can check `err.name`. The worker is not terminated: a clone failure never
reaches it, and it stays usable for later valid requests.

### Added — `form().dispose()`

A form creates one derived `error` per field plus five aggregates (`errors`,
`isValid`, `isDirty`, `touched`, `values`), and none of them could be released. A
validator that reads a caller-owned signal kept its subscription for as long as
that signal lived, and DevTools retained every node of an abandoned form.

`FormReturn` now carries `dispose()`:

```ts
const f = form({ age: { initial: 0, validators: [(v) => (v < minAge() ? "Too young" : null)] } });
onCleanup(f.dispose, formElement);
```

It releases the aggregates first, then every field error, and is idempotent.
Each derived emits its DevTools `computed:destroy` event. Afterwards the derived
accessors are inert: they return their last settled values and never recompute
or resubscribe. Field `value()` and `set()` keep working as plain signals.

### Fixed — `hotkey()` dropped unknown combo modifiers

The combo parser silently ignored any modifier it did not recognize, so
`hotkey("mod+s", save)` registered a shortcut with no modifier at all: it fired
on every plain "s" (including inside text inputs) and never on Ctrl+S or Cmd+S.

- **`mod` modifier** — resolves to Cmd on Apple platforms and Ctrl everywhere
  else, so `hotkey("mod+s", save)` works cross-platform with one registration.
- **`option`** is accepted as an alias for `alt`.
- **Unknown modifiers throw** — `hotkey("hyper+s", fn)` now throws
  `hotkey("hyper+s"): unknown modifier "hyper"` instead of matching the bare key.
- **The `+` key** is written as a trailing plus: `hotkey("+", fn)`,
  `hotkey("ctrl++", fn)`. A combo with no key (`"ctrl+"`) throws.

### Fixed — widget DOM updates bypassed `ErrorBoundary`

`VirtualList` and several widget `bind()` methods drove their DOM updates with a
plain `effect()`, which carries no owner node. When an update threw on a later
scheduled run — a `renderItem`, `option` or `cell` callback, or a DOM write — the
error was reported with `node: undefined`, so the enclosing `ErrorBoundary` could
never claim it and it fell through to the global handler.

These updates are now owned DOM bindings, so a later failure carries
`phase: "binding"` and the owner node, and the nearest boundary renders its
fallback:

| API | Owner node |
|---|---|
| `VirtualList` | the list container |
| `combobox().bind()` | `els.input` |
| `select().bind()` | `els.listbox` |
| `datePicker().bind()` | `els.grid` |
| `tabs().bind()` | `els.tablist` |
| `accordion().bind()` | `els.root`, or the first trigger |
| `fileUpload().bind()` | `els.input` |
| `popover().bind()` | `els.trigger` |
| `tooltip().bind()` | `els.trigger` |
| `bindField()` on a `<select multiple>` | the select element |

Behaviour is otherwise unchanged: the updates stay inert during SSR and are
released by the same teardown / `dispose()` paths as before.

## [4.5.0] — 2026-09-13

### Added — `derived().dispose()`

`derived()` subscribes to its sources when it is created, and there was no way
to release those edges. A derived created per mount (one per virtualized row,
say) accumulated subscribers on its sources for as long as they lived. The
returned accessor now carries `dispose()`:

```ts
const selected = derived(() => range().top <= index && index <= range().bottom);
onCleanup(selected.dispose, rowElement); // released when the row is disposed
```

Disposal unlinks every source edge and is idempotent. A disposed accessor is
inert: it returns the last value it settled, never recomputes, never
re-subscribes, and never wakes downstream readers. The return type is now
`DerivedAccessor<T>` (`Accessor<T> & { dispose(): void }`), which is assignable
wherever `Accessor<T>` was.

Disposal is safe from inside the derived's own getter: edges recorded by reads
that follow the `dispose()` call in the same recomputation are released when
that run finishes, and the dirty marker is inert once disposed, so a
self-disposing derived ends with no source subscriptions either way.

A getter that disposes its own derived and then throws no longer loses the
exception, whether the derived is read directly or through other deriveds.
When the scheduler validates a derived for a subscriber, it swallows a failure
and lets the subscriber run, expecting the subscriber's read to throw again. A
disposed derived returns its frozen value instead, and a derived downstream of
one recomputes against that frozen value and succeeds, so the error vanished.

A failed recomputation now keeps its exception and throws it to the next reader
exactly once, in that reader's own context: a binding reports it with its node,
so the nearest `ErrorBoundary` can claim it; an effect reports it as an effect
failure; a direct caller can catch it; and a derived reading it fails and keeps
it in turn, so the error travels up a chain to the first binding, effect or
direct caller. A live derived stays dirty and recomputes on the following read;
a self-disposed one returns its frozen value. Disposing a derived that still
holds a failure keeps it: the next read throws it once, and later reads return
the frozen value.

A reader that receives a live derived's failure stays subscribed to it. The
edge is recorded before the error is thrown, so a binding that catches it (and
an effect or derived chain that reports it) runs again once the sources
recover, instead of being pruned and left stale. A write also still reaches the
dependents of an intermediate derived whose last recompute failed.

Disposal also emits a `computed:destroy` DevTools event, read from the global
hook at disposal time, and DevTools drops the node from its inventory. Without
it, deriveds created and disposed per row kept accumulating in `hook.nodes`
during development.

APIs built on `derived()` pass the disposer on or use it themselves:

- `writable()` returns `[DerivedAccessor<T>, setter]`, so `getter.dispose()`
  is available from TypeScript.
- `select()` on the Redux and Zustand adapters returns `DerivedAccessor<R>`.
  Each selector subscribes to the adapter's state; dispose one that is
  discarded before the adapter.
- `query().dispose()` disposes its internal `loading` and `isStale` deriveds,
  and `infiniteQuery().dispose()` its `data`, `loading`, `hasNextPage` and
  `hasPreviousPage`. Their source edges and DevTools entries are released; a
  retained result keeps returning the last values.
- `pagination()` returns a `PaginationResult` with `dispose()`. Its
  `totalPages` and `endIndex` subscribe to the caller's `totalItems`, which
  normally outlives the pagination and kept the whole derived graph alive;
  `dispose()` releases all four internal deriveds and is idempotent.
- `timeline()` returns `dispose()` for its `value`, `canUndo` and `canRedo`
  deriveds. They read only the timeline's own signals, so this matters for the
  DevTools inventory rather than for retention.

### Fixed — `bindBoolAttr()` reported nothing when its getter threw

The getter's exception was caught and dropped, leaving the attribute stale
with no report anywhere — including a derived's deferred failure. It now goes
through the runtime error pipeline as a `"binding"` failure named
`bindBoolAttr`, carrying the element, so the nearest `ErrorBoundary` can claim
it, exactly like `bindAttribute`. The attribute keeps its last value.

### Fixed — `show()`, `when()` and `match()` bypassed `ErrorBoundary` on updates

Their reactive subscriptions carried no owner node, so a condition, selector or
branch factory that threw on a later scheduled update was reported with no DOM
position: the enclosing `ErrorBoundary` could not be found and the error went
straight to the runtime handler or the console. The subscriptions are now
stamped with the element (`show`) or the anchor (`when`, `match`), as reactive
class and style bindings already were, so the boundary claims the failure and
recovers normally after its reset.

### Fixed — tracking scopes created inside `untracked()`

A binding, effect or derived recomputation that ran inside an `untracked()` body
inherited the suspension:

- A binding created inside `untracked()` never subscribed to the deriveds it
  read, so it stopped updating when they changed.
- A derived-of-derived that recomputed while read through `untracked()` had its
  upstream edge pruned and stayed **stale permanently**.
- An `untracked()` nested inside such a binding leaked its reads into the
  binding.

Tracking runs now start a fresh scope and restore the enclosing suspension when
they finish. `untracked()` still suppresses only its own reads.

### Changed — `each()` render callbacks run untracked

The first rows of a list render in a deferred pass outside any subscriber, but
rows added by a later update rendered inside the list's reactive update. A
signal read directly in the render body of such a row subscribed the whole
list, so writing to it re-ran reconciliation. The render callback now always
runs untracked, so both paths behave the same. Reactive reads belong inside the
bindings and effects a row creates (`div(() => item().name)`), which track in
their own scopes and are unaffected. Wrapping reads in the render body with
`untracked()` is no longer necessary, and remains harmless.

Because `render` runs once per key and untracked, unwrapping `item()` /
`index()` in its body captures one-time values that go stale when the key
receives a replacement item or moves. Pass the getters into the row
(`Row({ user, index })`) or read them inside bindings. The best-practices guide,
the todo and e-commerce examples and the migration guides previously showed the
unwrapping pattern and now show the getter form.

### Changed — booleans on `aria-*` attributes serialize as `"true"` / `"false"`

ARIA states are enumerated tokens, not presence-based boolean attributes: a
missing `aria-selected` means "not applicable", not "not selected". Booleans on
`aria-*` attributes now write `"true"` / `"false"` in every attribute writer —
tag factory props (HTML and SVG), `bindAttribute` / `bindDynamic`, `bindAttrs`,
`bindBoolAttr`, `svgElement`, `html` templates (runtime and compiled), and
therefore SSR, streaming SSR and hydrated output — matching what `enhance()`'s
`attr()` already did. Native boolean attributes (`hidden`, `disabled`,
`required`, …) keep presence semantics, `null` / `undefined` still remove any
attribute, and non-boolean values (`aria-checked="mixed"`, numbers) pass through
unchanged.

To remove an ARIA attribute, produce `null` or `undefined` instead of `false`:

- Props, `bindAttribute`, `bindDynamic` and `bindAttrs` take any value, so
  `"aria-x": () => (active() ? true : null)` writes `"true"` or removes it.
- `bindBoolAttr` accepts only `boolean | (() => boolean)` and coerces the
  getter's result with `Boolean()`, so it can no longer remove an ARIA
  attribute. Code that relied on `bindBoolAttr(el, "aria-x", false)` removing
  it should switch to `bindAttribute(el, "aria-x", () => (active() ? true : null))`.

### Documented — `media()` returns `{ matches, dispose }`

`media()` returns an object, not a bare `() => boolean`, and its `matchMedia`
listener stays attached until `dispose()` is called. The README, the
best-practices guide and its JSDoc now show the real shape and when to release
it:

```ts
const { matches: small, dispose } = media("(max-width: 640px)");

small();
dispose();
```

### Documented — `VirtualList` is one-dimensional

`VirtualList` virtualizes vertical scrolling with a fixed container height and
a fixed item height, and re-renders its visible window on every scroll. It has
no horizontal virtualization, frozen rows or sticky headers; two-axis grids need
their own windowing (nested keyed `each()`). Its JSDoc and the best-practices
guide now say so.

---

## [4.4.0] — 2026-09-07

### Added — `cdn.full.global.js`, patterns for no-build pages

A `<script>` tag resolves no specifiers, so a no-build page could not reach
`sibujs/patterns` at all: `machine` and its siblings were unavailable to the
audience islands are most often used by. They now ship in a second CDN bundle,
a superset of the default one, under the same `Sibu` global with the namespace
kept as `Sibu.patterns`. Core is spread last so it wins any collision. New
export paths: `sibujs/cdn-full` and `sibujs/cdn-full-dev`.

A separate artifact rather than a merge, and that is the whole point. Merging
patterns into `cdn.global.js` charged every no-build page +13.0% gzip for code
it never calls — measured, reviewed, and reverted before release. Pages that
want `machine` ask for it by URL; pages that want `signal` are not billed for
it.

**Size, measured.** The default bundle came out of this smaller than it went
in, because it also lost esbuild's `globalName` wrapper (below):

| bundle | before | after |
| --- | --- | --- |
| `cdn.global.js` | 80,202 B raw / 26,330 B gzip | 76,490 B / 26,118 B (−4.6% / −0.8%) |
| `cdn.dev.global.js` | — / 30,199 B gzip | 85,526 B / 30,005 B (−0.6%) |
| `cdn.full.global.js` | — | 85,972 B / 29,605 B |
| `cdn.full.dev.global.js` | — | 95,539 B / 33,661 B |

Gzip figures are `zlib` level 9, which is what the budget test asserts — the
default level is not reproducible across zlib builds.

Nothing changes for ESM/CJS consumers — their entry points are untouched and
still tree-shake per import.

### Fixed — `validateProps` and `assertType` ran in production browsers

`patterns/contracts.ts` decided dev-vs-production by reading
`process.env.NODE_ENV` directly. That is not a `define` target, so no bundler
could fold it, and `process` does not exist in a browser at all — which the
guards read as *development*:

- `validateProps()` performed full validation and emitted `console.warn` on
  every production page, and its message text shipped in the bundle.
- `assertType()` threw instead of returning early, in exactly the builds its
  own doc comment promised it would be a no-op.

Both now gate on `DEV`, the foldable flag the rest of the framework uses, with
the warning built inside the guarded branch so the string folds away with it.
Behaviour for ESM/CJS consumers who define `__SIBU_DEV__` is unchanged; a
browser build that defines nothing now treats itself as production, matching
every other diagnostic in the library.

This surfaced only because `patterns` briefly became a CDN artifact. It had
been latent for as long as `contracts.ts` existed, invisible while the module
was reachable only through a bundler that set `NODE_ENV`.

`tests/dist-artifacts.test.ts` now executes the published IIFEs and asserts the
behaviour rather than grepping for strings: `validateProps` warns in the
development bundle and neither validates nor warns in the production one, and
`assertType` throws in one and is a no-op in the other. The hand-maintained
marker list missed this for a full release, which is the argument for testing
what the bytes DO.

### Fixed — the contract diagnostics are now actually stripped, not just silenced

The first pass at the fix above gated on the imported `DEV` const. That made the
behaviour correct — nothing warned, nothing threw — while leaving the code in the
bundle: esbuild folded `DEV` to `!1` and emitted `if (!1) { … }`, because a
cross-module const is substituted AFTER dead-code elimination has run. The
assertion body and the `[SibuJS Contract]` message shipped behind a condition
that could never be true.

Both gates now lead with a bare `__SIBU_DEV__`, which is a `define` target and
is therefore substituted early, before elimination — the shape `devWarn` has
always used, and the same ordering `src/core/dev.ts` documents. The dead blocks
are gone from the artifact.

Note for anyone auditing this: `"… is required"` and `"… must be one of:"` DO
appear in the production bundle and must. They are the return values of the
exported `validators.required` and `validators.oneOf`, which run in production
by design. Only `[SibuJS Contract]` and the prop-validation warning are
diagnostics, and only those are asserted absent.

`tests/dist-artifacts.test.ts` and `tests-browser/cdn-full.spec.ts` both pass a
SPY validator to `validateProps` and assert it is never invoked in the
production bundle, with the development bundle as the positive control. "It did
not warn" would also pass for a branch that ran and stayed quiet.

Getting that residue out took two attempts. The first moved validation into a
second pass over the schema — free of validation-only allocations in
production, but it reordered
USER CALLBACKS: defaults and validators are both supplied by the caller, and
running every default before any validator means a later property's factory no
longer observes what an earlier property's validator wrote. Schema entries are
processed in insertion order and each property is finished — normalize, default,
validate — before the next begins, so `validateProps` now branches into two
whole loops, one per mode, instead of splitting the work into two passes.

The same reasoning caught one more. Normalizing a shorthand schema entry into
`{ type: def }` is validation-only work, and it was still happening in
production because both modes shared a helper that did it — which is also
exactly where such an allocation hides from a test that reads
`validateProps.toString()`. The two paths are now written out separately and
the production loop skips shorthand entries outright: a bare validator carries
no default, so that mode has nothing to do with it. Production is now the props
copy, one loop over the schema entries, and the defaults it applies — the two
allocations the work itself requires, and no validation-only ones.

One residue outlived the first two passes. `validateProps` collected its
findings in an `errors` array declared above the loop that fills it — outside
the guard — so the validation branch stripped cleanly while the allocation in
front of it did not, leaving `let r = []` on every production call, forever
unread. The array is declared inside the guarded loop, so the whole development path
folds together. The production
function is `{...props}` plus the defaults loop and nothing else, and a test
asserts the shipped function contains no array literal at all.

### Fixed — the CDN builds no longer take esbuild’s `globalName`

`globalName: "Sibu"` makes esbuild emit `var Sibu = (() => { … })()`, and that
assignment runs AFTER the module body. `cdn.ts` installs its object from inside
the body, so the wrapper overwrote it with the module’s own export namespace.
Harmless while the two matched; silently wrong the moment they did not, which
is what happened the first time a bundle merged anything in.

Both entry points now assign `globalThis.Sibu` themselves and the config sets
no `globalName`. The bundles self-register in a worker as a result, and are
~3.7 KB smaller for losing the wrapper.

A first version of the test missed this because it ran the IIFE against a
`window` stand-in that was not the context’s global, so the two assignments
landed in different slots. It now runs with `window === globalThis`, as a
browser has it.

---

## [4.3.0] — 2026-09-07

Two defects where a value of the right *shape* was judged by the wrong test, so
the runtime confidently did the wrong thing and said nothing. Both predate 4.2:
the `instanceof Promise` check dates to the first commit, the island
registration union to the reactive-islands release.

### Fixed

- **An island loader that was never wrapped in `lazyIsland()` was run as a
  setup.** A setup and a loader are both plain functions, so nothing can tell
  them apart before one is called. Invoked as a setup, the loader ignored its
  `ctx` and returned the import promise. The module *was* fetched — `import()`
  ran — but nobody awaited it, so the setup it resolved to was discarded and
  never ran. `enhance()` then returned normally and the element was stamped
  `data-sibu-enhanced="true"`: a marker asserting an enhancement whose real
  setup had never executed.

  The guard lives in `enhance()`, not in `mountIslands`, because `enhance()` and
  `enhanceAll()` are public and reach the same defect directly. A setup
  returning a thenable now throws *before* the commit that records ownership and
  sets the marker, so the transaction rolls back and the root is left exactly as
  unenhanced as it started.

- **A rolled-back enhancement could still be mutated afterwards.** Detecting the
  thenable and unwinding was only half of it: the async setup keeps running
  after its first `await`, still holding `ctx`, and could register listeners,
  bindings and cleanups into an enhancement that no longer existed. The root
  carried no marker and the disposer had already drained, so those registrations
  could never be released. A setup that queued a microtask and then threw
  synchronously escaped the same way.

  The context is now closed once its transaction unwinds, and every mutating
  method refuses afterwards with a dev warning rather than dropping the call in
  silence. Closing happens *after* the teardowns drain, because a teardown may
  legitimately register another cleanup while unwinding — documented behaviour
  that still works. Disposal closes the context too.

- **`Suspense` decided "is this async?" with `instanceof Promise`.** That asks
  which realm built the object, not what it can do. A promise from an iframe, a
  `vm` context, a worker bridge or a polyfill failed the test and was treated as
  a DOM node: `insertBefore` threw, the boundary rendered its error branch for
  work that was about to succeed, and the element the promise resolved to was
  never inserted and never disposed — live reactive bindings attached to
  nothing.

  The check is now by shape (`typeof value.then === "function"`), which is what
  `await` itself accepts. Nodes are excluded by a realm-agnostic `nodeType`
  test, so a custom element exposing a `then` method is still inserted rather
  than awaited.

- **`Suspense` dropped a fallback element from another realm.** The async check
  was made realm-agnostic; the fallback check was not, so `instanceof
  HTMLElement` silently discarded it and the boundary rendered nothing at all
  while its promise stayed pending. Both now use the same `nodeType` test.

### Changed

- **An `async` enhancement setup now throws instead of half-working.**
  Previously everything before its first `await` was registered and everything
  after it escaped the transaction. It was never supported — `EnhanceSetup`
  returns `void | (() => void)` — it simply failed quietly. Make the setup
  synchronous and do async work inside an effect or a lifecycle hook.

- **`Suspense`'s props match what it accepts.** `nodes` is typed
  `() => HTMLElement | PromiseLike<HTMLElement>`, so the cross-realm and
  thenable values the fix exists for no longer need a cast; `fallback` is typed
  `(() => HTMLElement) | HTMLElement`, which the runtime already handled.

### Added

- **`LazyIslandLoader`** — the branded type `lazyIsland()` returns, exported for
  callers that want to be explicit.

  `IslandRegistration` deliberately still accepts an *unbranded* loader.
  Requiring the brand would catch a forgotten `lazyIsland(...)` at compile time,
  which is where a mistake is cheapest to find, but it rejects code that
  compiles today — and this package's contract is that existing public API keeps
  working, with a codemod for anything that cannot be widened. There is no
  codemod infrastructure to ship one through, so the narrowing is not taken and
  the runtime guard carries the fix instead. A test records that decision, so a
  later tightening cannot happen by accident.

The enhancement guard's error is thrown in production as well as development — a
check that stops a broken enhancement being reported as successful cannot be
development-only. Only its long explanation is compiled out, leaving a short
message; `tests/dist-artifacts.test.ts` asserts both halves.

---

## [4.2.0] — 2026-09-06

Making the runtime loud where it used to be quiet. Every item below is a case
where the library did the wrong thing — or the right thing for an unstated
reason — without saying so, and the cost was paid by whoever had to guess. Two
widened signatures, one new runtime behaviour, four new development warnings,
and a production bundle that is *smaller* than 4.1.0 despite all of them. No
breaking changes.

### Fixed

- **Development diagnostics now actually compile out of production builds.**
  They did not. The dev gate led with a `globalThis.__SIBU_DEV__` lookup, and a
  member expression is not something a bundler can substitute or fold — so
  nothing was ever eliminated and every warning string the library can emit
  shipped to every consumer, to be tested at runtime and never printed.

  The gate is now a statically foldable constant, and the warning helpers test
  the build-time define inline so their bodies fold to nothing even in a
  published `dist` chunk. A production consumer's bundle no longer contains the
  diagnostics at all — so the core runtime is smaller than 4.1.0 despite
  everything added below:

  | gzipped, minified, `__SIBU_DEV__: false` | 4.1.0 | 4.2.0 |
  | --- | --- | --- |
  | `sibujs` | 26,895 | **25,836** |
  | `sibujs/plugins` | 28,877 | **28,615** |
  | `sibujs/ui` | 16,462 | **16,112** |
  | `dist/cdn.global.js` | 27,289 | **26,224** |
  | application exercising every warning below | 33,658 | **32,958** |

  `tests/treeshaking-dev-diagnostics.test.ts` bundles for real and fails if any
  diagnostic string survives, and `tests/dist-artifacts.test.ts` asserts the
  same thing against the built `dist/` files — the source-level test could not
  see the CDN bundle, which is exactly where the leak hid. Development builds
  grow, which is where the diagnostics are supposed to be: the same application
  is 53,079 bytes gzipped with `__SIBU_DEV__: true`.

- **The CDN bundle shipped every diagnostic and could not be stripped.** The
  CDN build applied no `__SIBU_DEV__` define at all, and a
  `<script src="…/cdn.global.js">` consumer has no bundler to fold it later —
  the published bytes are what runs. Worse, with no define and no `process` in
  a browser the dev gate resolves to `false` at runtime, so those thousands of
  bytes of warning text were downloaded and parsed to never print.

  `dist/cdn.global.js` is now built with `__SIBU_DEV__: false` and contains no
  diagnostic text at all.

### Added

- **`dist/cdn.dev.global.js`** — a development CDN bundle, exported as
  `sibujs/cdn-dev`. Stripping the production CDN would otherwise have left
  no-build users with no diagnostics at all; loading this file instead turns
  every warning on without a build step, which is the point of having them in a
  no-build workflow. Use `dist/cdn.global.js` in production.

- **`RouterLink` ignored a reactive `class`.** Tag factories honour a getter or
  a `{ name: condition }` map; `RouterLink` read the prop with
  `typeof classAttr === "string"`, so any other form fell through to `""` and
  the attribute was simply never written — no error, no class, no clue. It now
  resolves the prop through the same helper the tag factories use, inside the
  effect that maintains active-link state, so a getter is genuinely reactive
  rather than merely accepted.

- **A focused field lost the caret on every reactive rebuild.** A block that
  re-creates its children takes focus,
  selection and IME state with it, so typing one character into an input inside
  such a block ended the edit. Focus and the selection range are now restored
  when the rebuilt subtree contains an element of re-establishable identity
  (`data-focus-key`, `id`, or `name`), and the runtime warns in development when
  it cannot.

  It does not guess. A match must be unique — `name` is shared by every radio in
  a group, and moving the caret to a sibling control is worse than losing it —
  and focus is only restored when it was genuinely lost, never when the rebuild
  moved it somewhere deliberately. An in-progress IME composition cannot be
  preserved at all, because the composition belongs to the destroyed node; the
  warning says so rather than implying otherwise.

- **The style sanitizer dropped `url()` declarations in silence.** The guard is
  correct and stays — `url()` in an inline style is an exfiltration channel —
  but a blocked `background-image` reads as a rendering bug, not a security
  decision, and images rendered as empty boxes across several renderers with
  nothing in any console. Each dropped declaration is now announced in
  development, naming the property, the value, the element, why it went, and the
  sanctioned alternatives (`<img>` for content, a stylesheet class for
  decoration — stylesheet CSS is not sanitized). Exactly one warning per dropped
  declaration, de-duplicated per element so a reactive style cannot flood the
  console.

- **The duplicate-runtime warning gave obsolete advice.** It told users to
  configure `optimizeDeps.exclude`, which the reactive core's global registry
  already makes unnecessary — every copy routes through the first one, so signal
  writes reach subscribers registered by any of them. Duplication is a size
  problem, not a correctness one, and the message now says that.

### Changed

- **`show`, `when` and `match` accept both an element and a factory.** The
  shapes disagreed: `show(cond, element)` took an element while
  `when(cond, () => el)` took thunks. Passing the wrong one produced an obscure
  `TypeError` from inside the directive, or — for `when` — rendered nothing at
  all and said nothing. Every form is accepted everywhere now; a factory is
  still rebuilt per switch, and a bare element is re-attached as-is.

  A re-attached element keeps its own reactive bindings: the directive did not
  create it and does not tear it down. Development warns on the reuse, because
  the node also brings back whatever state it accumulated while detached.

- **The lone-string class warning is narrower, and reports once.** It now
  requires two or more whitespace-separated tokens with at least two
  utility-shaped, where before any single token carrying a hyphen, colon, slash
  or digit was enough.

  The old rule flagged the identifiers applications legitimately render as text
  — `item-0`, `home-content`, `user-42`, `v4.1.0`, `src/index.ts`,
  `https://example.com`, `N/A` — at a measured 29.8% false-positive rate, and a
  list rendering `item-0` through `item-999` produced a thousand warnings. The
  new rule measures 0% on the same 131-string corpus, and a repeated mistake is
  reported once per tag and string rather than once per element.

  Both de-duplication caches are bounded at 100 distinct entries, and reaching
  that bound stops reporting rather than merely stopping remembering — the
  latter would let every mistake after the hundredth warn on every render, which
  is the flood the cache exists to prevent. The suppression announces itself
  once, so nothing goes quiet without saying so.

  The cost, stated plainly: single-token class lists no longer warn.
  `div("space-y-6")` and `div("truncate")` pass silently, where the first used
  to be caught. A single hyphen-and-digit token is not distinguishable from an
  identifier, and a warning developers learn to ignore protects nobody. The
  multi-token form remains both the originally reported bug and the dominant
  real-world shape. Measurements live in
  `tests/lone-string-heuristic-rate.test.ts`.

- **Sanitizer entry points take an optional context.** `sanitizeCSSValue`,
  `sanitizeStyleAttribute` and `sanitizeAttributeString` accept an optional
  property/element used only to enrich the development warning. It never changes
  a security decision, and every existing call site keeps working.

### Documentation

- Every exported function reachable from an entry point now carries a doc
  comment saying what it does and what it returns — the router's navigation and
  guard API, the form validators, the tracking primitives, and the widget and
  UI factories among them. Signatures that used to require reading
  `dist/index.d.ts` are documented at the source.

- Functions that participate in a known trap say so, and name the way out:
  `when` and `match` carry the keying pattern that avoids destroying a live
  edit; `show` explains when to prefer `when` and what that costs.

---

## [4.1.0] — 2026-09-03

Progressive-enhancement ergonomics, driven by building a complete chess
application as a single enhanced island. Two additive public APIs, two
correctness fixes, and the documentation the pattern was missing. No breaking
changes — a minor release because the public surface grew.

### Added

- **`external()` — reactive integration with state SibuJS does not own.** A
  domain engine, a canvas scene graph, an editor document, a cache a socket
  writes into: the runtime cannot see writes into objects it does not own, and
  now says so with a primitive instead of leaving every application to invent a
  revision counter. `source.track()` inside a getter declares "this reads the
  outside world"; `source.invalidate()` at the mutation site publishes the
  change. Tracking and invalidation are separate calls because they genuinely
  happen in different places.

  It never proxies, clones or diffs your object — it holds no reference to it.
  `invalidate()` is a signal write, so it participates in `batch()`, works
  inside `derived()` and `effect()`, respects consumer ownership (a disposed
  binding, effect or island is never invalidated), and routes a throwing
  consumer through the ordinary error pipeline with that consumer's own phase
  and node. It costs ~60 bytes gzipped on top of `signal` + `effect` and
  tree-shakes out when unused.

  One source is one invalidation domain; several sources give a feature
  independent update rates. See `docs/architecture/external-state.md` for the
  four state architectures, their costs, and how to profile invalidation
  fan-out.

  It is defined in `src/core/signals/signal.ts` rather than a module of its own,
  and deliberately so: the build splits `dist/` into shared chunks, and a module
  reachable only from the root entry lands in the index-only chunk beside
  `enhance`, `mountIslands`, `mount` and `each`. Importing it from `"sibujs"`
  would then have pulled the whole island runtime into a page that only wanted
  to make a canvas reactive — 77 KB instead of 9 KB, measured across esbuild,
  Rollup, Vite and webpack.

- **`ctx.each(target, describe)` — repeated enhancement bindings.** A board, a
  table, a keyboard, a legend: many elements the server already rendered, each
  needing several bindings. The callback receives the element and its index and
  returns a descriptor (`text`, `attr`, `class`, `show`, `on`, `cleanup`); every
  field is committed through the matching `ctx.*` helper, so ownership,
  disposal, attribute sanitization, write elision and error metadata are the
  same objects as the hand-written loop.

  It is sugar and deliberately nothing more: no expression parsing, no
  interpolation, no `eval`, no new DOM, no node moved or replaced. Targets may
  be a `@ref`/CSS selector or any iterable of elements; zero matches is a silent
  no-op; a descriptor mistake throws in development naming the element index and
  the offending key, inside `setup`, so the enhancement transaction rolls back.
  Anything the descriptor does not cover — `model`, listener options, a nested
  `enhance` — is written imperatively in the same callback, which receives the
  element.

  Measured at +9% setup cost for 64 elements × 4 bindings in a production build,
  and identical at update time.

### Fixed

- **An `enhance()` binding that throws on a later update now reaches the
  enclosing `ErrorBoundary`.** Every reactive helper on `EnhanceContext`
  (`text`, `attr`, `classed`, `show`, `model`) created its binding with
  `effect()`. An effect subscriber is stamped `phase: "effect"` and deliberately
  carries no owner node, because a generic effect has no DOM position. So when
  such a binding threw on a scheduled re-run — the only path where the
  notification drain, rather than the caller, reports the failure — it was
  reported as an effect with `node: undefined`. Since a boundary is located from
  the failing node, that branch was unreachable for every progressive-
  enhancement binding on the page, and the error fell straight through to the
  configured runtime handler or the console.

  All five now bind through `reactiveBinding(commit, el)` and report
  `phase: "binding"` with the element they own, matching every other DOM binding
  in the runtime. An error no boundary claims still falls through to the handler
  and then the console exactly as before. Server-side behaviour is unchanged:
  bindings created during SSR remain inert, as they were under `effect()`.

- **A reactive binding whose FIRST evaluation throws no longer survives as a
  zombie.** `reactiveBinding()` ran its initial commit before it constructed or
  returned the disposer. A commit that read a signal and then threw had already
  been linked to that signal by `retrack()`, but the throw escaped before any
  disposer existed — so no caller could ever hold one. For `enhance()` that
  silently voided the documented transaction guarantee: the setup error was
  caught and the enhancement rolled back, yet the failing binding was never in
  the teardown list to roll back. The next write to that signal re-ran the
  commit and mutated DOM belonging to an enhancement that had already been
  abandoned.

  The initial run now unwinds on failure: the subscriber is marked disposed (so
  anything already queued for it in the current drain is skipped), its owner
  node is dropped so a failed binding cannot retain a DOM subtree, its edges are
  released through the same `cleanup()` every disposal uses, and the original
  error object is rethrown untouched. A failed enhancement now leaves zero live
  subscriptions, mutates nothing afterwards, and leaves the root enhanceable
  again — which is what "a failed setup claims nothing" always promised.
  Successful bindings, later re-runs, later failures routed through the error
  pipeline, reentrancy protection, disposal idempotence and SSR inertness are
  all unchanged.

### Documentation

- `docs/islands.md` rewritten as the complete guide: the `EnhanceContext`,
  repeated enhancement, external mutable state, `enhance()` vs `mount()` and how
  to combine them in one feature, feature-local state, granular vs broad
  invalidation, lifecycle and cleanup, accessible conditional UI, performance
  profiling, an architecture decision table, and a table of common mistakes with
  their fixes.
- `docs/architecture/external-state.md` — four state architectures compared on
  complexity, runtime cost, memory, granularity and integration effort, with
  measurements on a 64-cell grid and how to profile invalidation fan-out.
- `docs/interop.md` — nine rules for running islands inside a page another
  framework owns, with two implementations verified in Chromium, Firefox and
  WebKit.
- `examples/chess/` — a complete chess game as an enhanced island: 64
  server-rendered squares, `ctx.each`, `external()` invalidation, per-square
  signals for the interaction hot path, a mounted move-history region, keyboard
  grid navigation, an accessible promotion dialog, two independent boards, and a
  deliberately broken island beside them. The rules come from `chess.js`, which
  is an example/development dependency only and is not reachable from any
  package entry point.
- `examples/interop-host.html` — a host framework that owns the page and swaps
  its content on client-side navigation, including the failure mode you get from
  skipping the disposer.

---
---

## [4.0.1] — 2026-08-29

An error-routing fix for reactive `class` and `style` bindings. No breaking changes.

### Fixed

- **A reactive `class` or `style` getter that throws on a later update now reaches the enclosing `ErrorBoundary`** — `tagFactory` registered all four reactive forms (`class: () => …`, `class: { active: () => … }`, `style: () => …` and `style: { color: () => … }`) with a bare one-argument `track(commit)`. That builds the correct self-retracking binding and correctly labels its failures `phase: "binding"`, but it supplies no owner node, so the subscriber carried `node: undefined`. When such a getter then threw on a scheduled re-run, the runtime reported the failure with no DOM position to work from: the boundary-propagation event had nowhere to dispatch from, no enclosing `ErrorBoundary` could be located, and the error skipped the boundary entirely — falling straight through to the configured runtime error handler, or `console.error` when none was installed. Every other reactive attribute is bound through `bindAttribute`, which passes the element, so `class` and `style` were the only reactive props whose scheduled failures a boundary could never catch.

  All four now bind through `reactiveBinding(commit, el)` and report the element they belong to, so a boundary above the failing element claims the error and renders its fallback. An error that no boundary claims still falls through to the handler and then the console exactly as before — carrying a DOM node does not make a failure disappear. Class and style sanitization, disposal and cleanup registration, batching and scheduling, per-run dependency tracking, and synchronous initial-render semantics are all unchanged.

---

## [4.0.0] — 2026-08-28

SibuJS 4.0 is a stability release. The public API is the 3.x API: nothing was
renamed and nothing else was removed. The four breaking changes below are a
runtime floor, a browser floor, one narrowed overload, and one type field that
was never implemented.

The recurring theme of the fixes is **async ownership**: when asynchronous work
finishes, who still holds the right to commit it? Navigation, queries, hydration
bootstrap, island activation, optimistic-list operations, chunk loading and SSR
Suspense boundaries now answer that with monotonic generations rather than by
comparing keys, URLs, or values — because returning to the same key or URL is
*not* the same generation.

The second theme is **security as a postcondition**. Attribute writes, URL and
style sanitization, and `<head>` publication are enforced at the sink that
performs the write, so a new call site cannot reach the same DOM property by a
different path and skip the policy on the way.

The third is **verification**: the package is now certified the way a consumer
receives it — installed from a real `npm pack` tarball into throwaway projects,
across four bundlers, three browser engines, and every Node version in the
declared range.

### Migration to 4.0

1. **Upgrade Node before upgrading SibuJS.** Node 18 and Node 20 are not
   supported by 4.0 and are both already end-of-life (April 2025 and April
   2026). Run Node 22.3.0 or newer.
2. **Check your browser targets.** The supported floor is now Chrome/Edge 93,
   Firefox 92 and Safari 15.4, up from Chrome 80 / Firefox 78 / Safari 14. The
   old floor was never real — the source already used APIs those versions do not
   have — so this states what 3.x also required, and now enforces it.
3. **Replace `loadWasmModule(source, options)` with
   `loadWasmModuleWithOptions(source, options)`.** Calls passing real imports, or
   the positional `(source, imports, cacheKey)` form, are unchanged. The compiler
   finds every affected site.
4. **Drop `extends` from any `CustomElementOptions`.** It was read nowhere and
   advertised customized built-in elements that were never implemented.

Nothing else in your application needs to change: no other public API was
removed or renamed, and several type declarations became *more* permissive, so
code that compiled against 3.x still compiles.

If you cannot move off Node 18/20 yet, stay on 3.4.x — noting that SSR request
isolation never actually worked there under ESM. See below.

### Breaking

- **Minimum Node.js is now 22.3.0** (was 18.0.0). SSR request isolation is built
  on `AsyncLocalStorage`, which the runtime loads through
  `process.getBuiltinModule` — added in Node 22.3. The fallback for older
  releases never worked: it looked for `require` in global scope, where it does
  not exist in either module format. Below 22.3, concurrent SSR requests
  therefore shared one store, so request state and the query cache could bleed
  between them.

  The CommonJS half is now fixed and isolates correctly on every version. The
  ESM half cannot be: there is no synchronous way to load a builtin module from
  ESM before `getBuiltinModule` existed, and a static `import "node:async_hooks"`
  would break every browser bundle. Node 18 (EOL April 2025) and Node 20 (EOL
  April 2026) were the only versions failing any gate, so the floor was raised to
  the version that actually provides the mechanism.

  Every version in the declared range is now executed by CI on every pull
  request, against the packed tarball, in both ESM and CommonJS. Where
  `AsyncLocalStorage` is genuinely unavailable — a browser, a DOM-less edge
  runtime — `runInSSRContext` now emits a one-time warning instead of degrading
  silently. A fully synchronous render was never affected.

- **Browser support floor raised to Chrome/Edge 93, Firefox 92, Safari 15.4.**
  The declared floor was Chrome 80 / Firefox 78 / Safari 14, and nothing checked
  it — so the source drifted above the promise and a consumer targeting the
  declared minimum shipped a bundle that threw on first use. Three APIs are used
  without a feature guard and are unavailable at the old floor: `Object.hasOwn()`
  (Chrome 93), `ParentNode.replaceChildren()` (Chrome 86), and the `Error`
  `cause` option (Chrome 93). `Object.hasOwn` sets the binding constraint and
  sits inside the reactive core, so polyfilling `replaceChildren` alone would
  have left the bundle equally broken on Chrome 80–92. The floor now states what
  the source actually requires.

  This is enforced rather than documented: a compatibility gate parses
  `browserslist`, scans the source for each API in a baseline table, and fails
  when an unguarded usage needs a newer engine than the floor declares. Adding
  such an API now forces a deliberate choice — guard it, or raise the floor and
  update the support matrix. Everything else modern in the source is already
  feature-detected and does not constrain the floor.

- **`loadWasmModule()`'s second parameter is now `WebAssembly.Imports` only; the
  options form is `loadWasmModuleWithOptions()`.** The parameter used to accept
  `WebAssembly.Imports | LoadWasmOptions` and pick between them at runtime by
  probing for `allowedOrigins` / `unsafelyAllowAnyOrigin`. That discriminator is
  unsound in both directions, because both shapes are plain objects with
  caller-chosen keys: an options bag carrying only `imports`/`cacheKey` was read
  as an import namespace — so `cacheKey` was silently dropped and the documented
  keyed-singleton guarantee did not hold — while a WASM module namespace legally
  *named* `allowedOrigins` would have been read as options. No structural test
  can separate them, so the union was removed rather than re-guessed.

  Migration is mechanical and the compiler finds every site: a call passing an
  options object becomes `loadWasmModuleWithOptions(source, options)`. Calls
  passing real imports, or using the positional `(source, imports, cacheKey)`
  form, are unchanged. `wasm()` uses the options API internally, so its own
  surface is unaffected.

- **`CustomElementOptions.extends` is removed.** The option was public and read
  nowhere, so it advertised customized built-in elements that were never
  implemented. Real support needs the constructor to derive from the concrete
  element class, `customElements.define(name, ctor, { extends })`, and `is=""`
  at every call site — and Safari has never shipped them. Removed rather than
  faked.

### Added

- **`replaceChildrenSafely(parent, ...next)`** — replaces a node's children,
  disposing the outgoing subtree first. Native `replaceChildren()` detaches
  nodes without running SibuJS teardown, so bindings, listeners, and lifecycle
  hooks inside the removed content survive as unreachable zombies that keep
  firing against detached DOM. Application code that swaps SibuJS-managed
  content hits the same hazard the framework did, so this ships alongside
  `dispose()` and `checkLeaks()` rather than staying internal. Nodes present in
  `next` are never disposed, including when they currently sit *inside* the
  outgoing subtree.
- **`reason` on failed navigation results** — `NavigationResult` and
  `NavigationFailure` now carry an optional `reason` discriminator, typed as the
  newly exported `NavigationFailureReason`: `"guard"`, `"superseded"`,
  `"router-destroyed"`, `"redirect-loop"`, `"unsafe-target"`, `"duplicate"`, or
  `"error"`. Previously a guard rejection and a navigation
  superseded by a newer one were both `{ success: false, type: "aborted" }`, so
  applications could not tell "you lack access to this page" from "you clicked a
  newer link" — forcing a choice between spurious error messages during rapid
  navigation and swallowing genuine authorization failures. Existing `type`
  values are unchanged, so code branching on `type` is unaffected.

- **`asyncDerived()` now returns a `dispose()` method.** It previously created
  an internal effect with no way to stop it, so it stayed subscribed to its
  sources for the lifetime of the page. Disposal unsubscribes, aborts the
  in-flight run, ignores any promise that settles afterwards, makes `refresh()`
  a no-op, and is idempotent.
- **`asyncDerived()` factories receive an `AbortSignal`** through the newly
  exported `AsyncDerivedContext`. Forward it to `fetch` or any abortable API to
  cancel work that can no longer affect the result:
  `asyncDerived(async ({ signal }) => (await fetch(url(), { signal })).json())`.
  Superseded runs and disposal both abort. The run-id guard is retained because
  not every async API honours `AbortSignal`. Existing zero-argument factories
  continue to work unchanged.
- **The runtime error handling API**, exported from the package root — one place
  to observe every error the runtime catches and contains:
  `setRuntimeErrorHandler()`, `getRuntimeErrorHandler()`, `reportError()`, and
  the `RuntimeErrorHandler`, `RuntimeErrorContext` and `RuntimeErrorPhase`
  types. A handler receives the original error plus a context naming the phase
  (`effect`, `binding`, `derived`, `cleanup`, `event`, `async`, `render`,
  `scheduler`), the failing subscriber's debug name, and the associated node
  where one exists. Without a handler, errors go to `console.error`.
  `reportError()` is intended for plugin/integration code that catches an
  application exception on SibuJS's behalf; ordinary application code should use
  `ErrorBoundary` or `setRuntimeErrorHandler()`.
- Browser tests (Playwright) now run in CI: Chromium on pull requests,
  Chromium + Firefox + WebKit on `main`. They previously existed but ran only
  when invoked manually, so a real-engine regression could ship with CI green.
- Benchmarks for computed stabilization — workloads where an upstream write does
  *not* change the downstream value — reporting downstream effect runs alongside
  timings, so the run count cannot regress unnoticed.

### Changed

- **`@types/node` aligned to `^22.20.1`** (was `^25.5.0`) so the type definitions
  match the supported runtime floor. Typing against Node 25 while claiming Node
  22.3 lets TypeScript quietly accept an API the minimum runtime does not have.
  The source uses a small Node surface — `node:async_hooks`, `node:fs`,
  `node:path`, and `process.env` / `versions` / `getBuiltinModule` / `cwd` — and
  compiles clean against Node 22 definitions. Development tooling is unaffected;
  it runs on whatever Node the contributor has.
- **`package-lock.json` is now committed.** A library's lockfile does not affect
  consumers' dependency resolution, but without one CI could not use `npm ci` and
  silently re-resolved transitive dev dependencies on every run. It is not
  included in the published tarball.
- **Benchmark baseline re-recorded** with its environment captured alongside it
  (`bench-baseline.meta.json`: commit, Node, npm, OS, CPU, RAM, jsdom version).
  `npm run bench:check` remains **informational only** — on a shared host,
  consecutive runs against a freshly recorded baseline flag different benchmarks
  at the 20% threshold, so it is noise rather than a usable gate until it is
  re-recorded on the machine that will enforce it.

- **A reactive attribute value of `null`/`undefined` now removes the attribute**
  instead of writing the literal text `"null"`. `bindAttribute`/`bindAttrs`
  stringified the value before writing, so a getter returning null produced
  `title="null"` — visible to users as a tooltip reading "null". Absence is the
  only sensible reading, and it is what the tag factory and `enhance()`'s
  `attr()` already did. A getter returning the *string* `"null"` still writes
  `"null"`.

- Errors from a throwing `onCleanup` are now reported through the runtime error
  pipeline (`console.error` by default) instead of `console.warn`. Behaviour is
  otherwise unchanged: a throwing cleanup still does not prevent its siblings
  from running.
- `maxSubscriberRepeats` now defaults to 1 000 (was 50). Configurable via
  `setMaxSubscriberRepeats()`.

### Fixed

#### Route component loading

- **Route component factories now run once per instance, not twice.** The
  component loader validated a route component by *invoking it* and checking it
  returned an `Element`, discarding that node, and then invoking the component
  again for the node it actually mounted. Any side effect in a component factory
  — an analytics call, a store write, a push to a list — therefore happened
  twice on first load, and no amount of cleanup could undo it. Loading a route
  component and instantiating one are now separate operations: the loader
  resolves a *plan* (a factory, or a module to import) without ever running user
  component code, and the factory is invoked exactly once when an instance is
  genuinely needed. The return value is validated on the instance that will be
  mounted.
- **`preloadRoute()` no longer renders the route.** Because validation ran at
  cache-fill time, preloading a route instantiated its component and built DOM —
  the opposite of what preloading is for. Preloading never invokes route
  component factories now: only an explicitly branded loader — a route wrapped
  with `lazy()` — is executed, importing the module and caching its factory
  uninvoked. Every directly supplied factory, synchronous or `async` or plain
  promise-returning, is left untouched until real navigation. Because the
  factory is not invoked, preloading cannot surface component errors; those
  appear at navigation. A lazy module's *load* failure is still reported.
- **Preloadability is explicit, never inferred.** An earlier iteration decided
  which route functions were safe to execute during preload by looking for
  `import(` in `Function#toString()`. Source text is a representation, not
  metadata: an ordinary component mentioning `import(` in a string or a comment
  was executed during preload, and a bundler that rewrites dynamic imports into
  its own chunk loader would hide a real one. The `lazy()` brand is now the sole
  authority. A route written as `() => import("./Page")` still navigates
  correctly, but is no longer preloaded — wrap it in `lazy()` to restore that.
- **A direct `AsyncComponent` is no longer disposed before it is mounted.** For
  `component: async () => element`, the resolved Element was handed to the
  validation step, disposed as a discarded probe, cached as a reusable
  `() => element` factory, and then mounted — dead, with its bindings and
  listeners already torn down, and re-mounted on every later visit to that
  route. A resolved Element is now recognised as the instance for that one
  invocation: it belongs to the route generation that requested it, is never
  disposed before commit, and is never cached as a factory. Each visit invokes
  the component again and receives its own Element.
- **Load errors are recorded where the load happens.** The `errorRetryDelay`
  rate limit and the error-retry button behave as before; the bookkeeping moved
  to the instantiation path along with the work.

`AsyncComponent = () => Promise<Element>` remains a first-class supported route
component, and plain (non-`async`-declared) promise-returning functions still
work — the thenable check now runs on the real invocation instead of on a
discarded probe, so classification never costs a duplicate call.

#### Disposal and lifecycle

- **`each()` no longer leaves its rows behind when torn down.** Rows and the
  `each:end` sentinel are *siblings* of the anchor comment, not children, so an
  ancestor `dispose()` walk never reached them and only the reactive
  subscription was released. Swapping an `each()` out of a conditional branch
  left every row **visible on screen** beneath the replacement content, still
  reactive and still holding its bindings. The anchor now owns and tears down
  its whole logical range.
- **`Suspense` disposes its fallback when content resolves.** The commit used a
  native `replaceChildren()`, so a user-authored fallback — commonly reactive,
  e.g. a progress indicator — was detached without teardown and kept
  re-rendering off-screen forever, with its `onCleanup` never firing.
- **`ErrorBoundary` no longer commits async results into a disposed boundary.**
  A promise settling after the boundary was torn down built a fresh subtree
  inside a detached container that nothing would ever dispose. Late results are
  now disposed rather than attached, and a late rejection stays handled so it
  never surfaces as an unhandled rejection.
- **`replaceChildrenSafely()` preserves an incoming node nested inside outgoing
  content.** Protection was originally a membership test against the parent's
  *direct* children, so a node being moved up out of a wrapper was destroyed
  along with it — leaving a node in the final DOM whose reactive resources had
  already been torn down. It renders once, then silently stops responding.
  Incoming nodes are now detached before the outgoing roots are disposed.

#### Progressive enhancement and islands

Setup is now a **transaction over framework-owned resources**: success commits
lifecycle ownership, failure rolls back everything accumulated before the throw,
disposal ends ownership, and a retry or remount starts clean. Full detail in
`docs/architecture/enhancement-lifecycle.md` and
`docs/hardening/enhance-islands-findings.md`.

- **A throwing `enhance()` setup no longer leaves its bindings alive.** Teardowns
  accumulated as the setup called `ctx.text`/`ctx.attr`/`ctx.on`/`ctx.model`, but
  only became reachable through the disposer built *after* setup returned. An
  exception therefore escaped with every effect still subscribed and every
  listener still attached, and no disposer in existence anywhere that could stop
  them — a permanent zombie driving the DOM on behalf of an enhancement that
  failed. Setup now runs inside a transaction: accumulated resources are torn
  down and the original error is rethrown unchanged. Rollback covers what is
  registered through the context; work done outside it (`innerHTML` writes,
  requests, global mutation) cannot be reversed generically, so register its undo
  with `ctx.cleanup()`.
- **Disposal restores the root to an enhanceable state.** `dispose()` released
  every binding but left `data-sibu-enhanced="true"` behind, and `enhance()`
  refuses any root carrying it — so a disposed element could never be enhanced
  again. The marker now tracks *current ownership* rather than history: added on
  commit, removed on disposal, never added for a failed setup. Removal is
  ownership-checked, so a stale disposer replayed after the root has been
  enhanced again cannot strip the newer generation's claim. Enhancing a root that
  is **still active** remains refused, with the same dev warning.
- **`enhanceAll()` rolls back earlier enhancements when a later setup fails.** It
  mapped `enhance` over the matches, so a throw partway through escaped before
  the aggregate disposer existed — leaving the caller with live enhancements and
  no handle to release them. The collection is now one transaction, unwinding in
  reverse creation order. A teardown that fails during rollback is reported and
  skipped: it neither aborts the remaining rollback nor replaces the original
  setup error.
- **Island error isolation is now lifecycle isolation.** `mountIslands()` already
  contained a failing island's *exception*; because of the bug above it did not
  contain its *resources*. A failed island now leaves zero live bindings and zero
  live listeners, is marked neither enhanced nor hydrated, and can be mounted
  again once its setup is fixed. Siblings were, and remain, unaffected.
- **An island torn down during its own setup is disposed instead of stranded.**
  The asynchronous race (cleanup landing before a lazy chunk resolves) was
  already guarded; the synchronous one was not. If a setup reached the mount
  cleanup, the disposer list was drained before that island's disposer existed,
  and it was then pushed onto the drained list — leaving the island fully active
  and unreachable. Teardown is re-checked after `enhance()` returns.
- **`mountIslands()` cleanup releases the markup for remounting.** The same
  server HTML can be mounted again across the `load`, `idle`, `visible`,
  `interaction` and `media` strategies, activating a fresh generation with a
  single set of bindings. Mounting twice *without* cleanup still skips islands
  that are already active. `data-sibu-hydrated` is unchanged — it is hydration
  provenance rather than ownership, and gates nothing.
- **Cleanups registered during teardown are no longer silently dropped.** Both
  rollback and disposal drained the teardown queue for at most eight reentrant
  passes. Since `ctx.cleanup()` stays reachable *from inside* a cleanup, a chain
  longer than eight left its tail on a queue local to the enhancement — and
  therefore unreachable the moment the disposer returned, while the caller was
  told everything had been torn down. The queue is now drained until stable, so
  finite chains of ordinary practical depth complete. Runaway or excessively
  large teardown production is bounded by **total work executed** rather than by
  pass count (a pass count cannot tell a twelve-link chain from infinite
  recursion). That ceiling is an absolute work bound rather than a recursion
  detector — recursive self-registration is the usual way to reach it, but an
  exceptionally large finite chain reaches it too — and either case is reported
  with the number of teardowns run and still queued, instead of passing as
  completed cleanup. The drain is iterative and batch-spliced, so deep chains
  cannot overflow the stack and ordinary cleanup keeps its previous cost.
- **`dispose()` shares that policy.** The node-level disposer drain had the same
  boundary one offset further out (an initial batch plus eight extra passes).
  Its consequence was milder and is documented as such: leftovers stayed in the
  `WeakMap`, so they remained reachable through a later `dispose(node)` and were
  still counted by `checkLeaks()` — deferred rather than lost. Both now drain
  until stable or the safety ceiling is reached; at the ceiling, `dispose()`
  restores the untouched remainder to the map (keeping it reachable and counted)
  while an enhancement clears its unreachable queue, and both report.
- **Repeated enhance/dispose cycles no longer accumulate node disposers.**
  Reachable only now that roots are re-enhanceable: each `enhance()` registered a
  node-level disposer that only `dispose(node)` ever cleared, so a long-lived
  root retained one dead closure per generation. An internal
  `unregisterDisposer()` releases it; the soak asserts live-binding counts return
  to baseline across 10 000 cycles.

#### Client router

- **A superseded navigation can no longer commit.** Each navigation already
  carried an `AbortController`, and a newer navigation already aborted the
  previous one — but nothing consulted the signal before committing. A
  navigation superseded mid-flight would resume after its `await` and rewrite
  history, clobber the newer route, fire `afterEach`, and apply its scroll
  position. A single check at the commit boundary closes it, with two further
  checks so stale navigations stop early rather than merely failing late.
- **A navigation pending at `destroyRouter()` no longer commits afterwards.**
- **`KeepAliveRoute()` async stale-load protection.** The keep-alive outlet was
  the last place still deciding commit permission from a route *value*: after
  awaiting a lazy component it compared `route.path` against the current path.
  `route.path` strips query and hash, so `/search?q=a` and `/search?q=b` compared
  equal and a superseded load committed anyway — mounting and caching a view for
  a location the user had already left. Its `isUpdating`/`pendingUpdate` pair
  made this worse by deferring rather than superseding: an in-flight lazy load
  held the outlet for its whole duration, so intermediate navigations never
  rendered and the *first* generation committed at the end. It now uses the same
  monotonic generation as `Route()`, and cache identity (path + query + hash) is
  kept strictly separate from commit permission.
- **`KeepAliveRoute()` no longer resurrects a disposed outlet.** A lazy load
  resolving after the outlet was torn down inserted into the DOM and wrote back
  into the cache that had just been disposed and cleared — unreachable nodes that
  nothing could ever dispose. Teardown is now checked at the commit boundary and
  also advances the generation.
- **`KeepAliveRoute()` disposes nodes it builds but cannot commit.** The
  component was created *before* the staleness check, and a losing generation
  returned without disposing it, leaking every effect, listener, and disposer it
  had registered. Ownership is now checked before creation, and again at the
  commit boundary where the node is disposed rather than dropped.
- **`scrollBehavior` no longer fails navigations in DOM-less runtimes.**
  `handleScrollBehavior()` called `requestAnimationFrame` and `window.scrollTo`
  unguarded, while the history write beside it was already guarded. Because it
  runs *after* the route is committed, the `ReferenceError` propagated out and
  reported `success: false` on a navigation that had in fact succeeded — route
  state and the reported result disagreed. Both primitives are now probed
  independently (they can be missing separately), and the browser-only side
  effect is skipped while the route still commits.
- **`scrollBehavior` is not invoked when the runtime cannot scroll.** The
  environment guard now runs *before* the user callback rather than after it. A
  scroll hook is browser code — `() => ({ x: 0, y: window.scrollY })` is entirely
  ordinary — and running it server-side threw on the missing global before any
  guard was reached. Where SibuJS knows it cannot scroll, the hook is skipped
  entirely instead of being called for a result that would be discarded.
- **A failing scroll callback cannot revoke a committed navigation.**
  `scrollBehavior` is an optional, fallible **post-commit** side effect: once the
  route and history are committed they are authoritative. An exception from the
  callback — or from `window.scrollTo` on the scheduled frame, which runs outside
  the navigation promise and previously had no catcher at all — is now reported
  via `console.error` and leaves `NavigationResult.success` and `currentRoute` in
  agreement. Navigation correctness is not scrolling correctness.
- **`RouterLink` respects `event.defaultPrevented`.** It correctly declined
  modifier clicks, non-primary buttons, and `target`-bearing links, but never
  checked whether something had already cancelled the click — so a link the
  application had explicitly neutralised still navigated.
- **The router no longer throws an uncatchable error without a DOM.** Reading
  the current path assumed a live `location`. Listener registration was already
  guarded, but the deferred bootstrap still called through — and a throw from a
  microtask is a process-level error the caller cannot defend against with
  `try`/`catch`, so merely constructing a router in an SSG build or a test
  runner could take the process down. It now resolves to the root path, matching
  the route already seeded, and server-side callers navigate explicitly.
- **A route component returning a promise from a plain arrow is no longer
  dropped.** Async components were classified *syntactically* — the `lazy()`
  marker, an `async function`, or an `import(` in the source — so
  `() => fetchThing().then(...)` matched none of them despite being a valid
  `AsyncComponent`. It produced a misleading "must return Element, got object"
  and left the promise unhandled, so a later rejection escaped as an unhandled
  rejection. Any thenable is now adopted and awaited.
- **Redirect loops report the offending chain.** Recursion was already bounded
  at ten hops, but failed with a bare `aborted` and no explanation. Development
  builds now print the hop sequence, so a cycle is obvious the moment a path
  repeats.

#### SSR, hydration, and islands

- **SSR Suspense replaces its fallback instead of appending beside it.** The
  streamed swap script moved resolved nodes into the boundary wrapper without
  clearing it first, so the loading UI stayed on screen above the real content.
  Verified in Chromium, Firefox, and WebKit by executing the real swap script
  against live DOM.
- **`hydrate()` disposes the previous client tree when a container is
  re-hydrated.** First-time hydration is unaffected — inert server markup has
  nothing to tear down — but a second hydration orphaned the entire previous
  tree's bindings, listeners, and lifecycle hooks.
- **Hydration diagnostics now report text mismatches.** `HydrationMismatch`
  declared a `"text"` variant that could never occur: the walker descended only
  through element children. The single most common real-world mismatch — server
  and client disagreeing on *data* — went unreported while a trivial attribute
  difference was flagged.
- **`renderToStream()` and `renderToString()` produce identical output.**
  Streaming omitted the `data-sibu-ssr` provenance marker, so the two documented
  render paths emitted different HTML for the same input — a trap for anyone who
  streams in production but snapshots with `renderToString()` in tests.
- **A lazy island whose module arrives after `cleanup()` no longer activates.**
  It enhanced the DOM for a torn-down island and pushed its disposer onto a list
  already drained, leaving the enhancement permanently unreachable. Reachable in
  practice via the `load` strategy, whose cancel is a no-op.
- **SSR bootstrap renders the route the browser is actually on.** `hydrateRouter()`
  created the router from `location` but hydrated the component resolved from
  the *server's* path. When the two disagreed — stale cached HTML, a CDN serving
  another route's document, a proxy rewrite, or a user navigating before the
  bundle boots — bootstrap ended with the URL and router agreeing on one route
  while the DOM showed another. The live URL now wins; when no route matches it,
  the container is cleared rather than left showing unrelated content.
- **A superseded bootstrap can never regain the right to commit.** Its staleness
  check compared URLs, which cannot distinguish `/b` from `/b` reached again
  after visiting `/c` — an A→B→A round trip restored permission to work that had
  already lost it, and replacement hydration would then destroy the newer
  instance's state, effects, and listeners while the URL still looked correct.
  Commit permission is now a monotonic navigation generation.

#### Data layer

- **A shared query request is no longer cancelled by an unrelated subscriber.**
  The cache entry owned the in-flight promise while each query instance owned
  the `AbortController`, so one instance changing key or unmounting aborted a
  request other instances had deduplicated onto. The entry now owns the request
  and its cancellation; query instances are observers. A request is aborted only
  when the entry itself is abandoned — never when one observer leaves.
- **Deduplicated waiters no longer stay `fetching` forever.** A waiter refreshed
  its state only when the shared promise still matched the one it captured, but
  the owner clears that reference *before* waiters resume — so the check was
  false on every normal completion and the flag never came down.
- **A completed request is recorded even when the instance that started it moved
  on.** The cache write was gated on the initiator's local state, so when it
  changed key or was disposed the shared result was never committed and every
  other observer was stranded with no data. Cache commit and local commit are
  now separate permissions.
- **A request abandoned by `clearQueryCache()` can no longer report settlement**
  while a newer request for the same key is still in flight.
- **`clearQueryCache()` keeps every live observer attached.** It replaces each
  cache entry and restarts live queries, but registration was driven by the key
  string — unchanged across a clear — so only the observer that happened to
  recreate the entry re-registered. Every other observer stayed live but
  detached: it missed later cache updates and invalidations, and the entry's
  subscriber count could reach zero while observers remained, making it eligible
  for garbage collection. Attachment is now keyed on cache-entry identity.
- **The query cache's retention timer no longer holds a Node process open.** The
  garbage-collection timer is pure bookkeeping, but a ref'd handle kept the event
  loop alive for the whole retention window — 300 s by default — so an SSG build,
  a CLI, or a serverless invocation that merely touched `query()` would hang long
  after finishing its work. The handle is now `unref()`'d where the runtime
  supports it, which changes only whether the timer keeps the process alive,
  never when it fires.
- **`infiniteQuery()` clears its fetching flags when the current request is
  aborted.** The stale-run guard was correct, but an abort on the *current* run
  returned before clearing the flags it had raised, so the query reported
  `fetching: true` permanently with no request in flight. Abort detection also no
  longer depends on `DOMException`, which is unavailable in some runtimes.
- **Data observer callbacks are isolated from each other.** Cache notification
  iterated listeners unguarded, so one observer whose `select` threw aborted the
  loop and starved every observer registered after it — on a request that had
  succeeded. Because that loop sat inside the request's own `try`, the selector's
  error was then written to the *shared* cache entry as the request's error and
  broadcast to everyone, and the re-notification threw again from inside the
  `catch` and escaped as an unhandled rejection. Listeners are now invoked
  individually over a snapshot of the set.
- **A callback exception is no longer treated as an operation failure.**
  `select`, `onSuccess`, `onError`, `onSettled`, and `onStart` all ran inside the
  `try` that decides the operation's outcome, across `query()`, `resource()`,
  `infiniteQuery()`, and `mutation()`. A throwing `onSuccess` was therefore
  caught by the catch meant for the fetch: the success state was overwritten with
  the callback's error, `onError` was invoked with it, and — for `mutation()` —
  an already-committed `success` status flipped to `error` and `mutateAsync`
  rejected. Throwing `onError`/`onSettled` escaped entirely as unhandled
  rejections from the fire-and-forget paths (effects, timers, `mutate()`), and
  skipped `onSettled`.

  The status of an operation is now decided by the operation itself. Callback
  exceptions are reported separately via `console.error` — never swallowed, and
  never routed into the operation's error channel. Callback order is pinned:
  state commit → `onSuccess`/`onError` → `onSettled`, with `onSettled` running
  even when the callback before it threw.

  `mutation()`'s `onMutate` is deliberately exempt: it is a step *of* the
  mutation that produces the rollback context, not a notification, so its failure
  remains a mutation failure. Optimistic rollback behaviour is unchanged.

#### Node compatibility

- **Router navigation in DOM-less runtimes.** `updateHistory()` referenced the
  bare `history` global, so every `push`, `replace`, and redirect failed with
  `ReferenceError: history is not defined` outside a browser. `createMemoryRouter`
  — documented as a router that "doesn't interact with browser history" and
  advertised for testing/SSR — could be constructed and then never navigated. The
  route now commits and only the address-bar side effect is skipped. Every router
  test ran under jsdom, where `history` is always present, which is why this
  survived; a consumer wiring up jsdom by hand has no reason to copy it.

#### Type declarations

These are all *widenings*: they accept strictly more than before, so code that
compiled against 3.x still compiles. They were found by type-checking the test
suite for the first time, which went from 130 errors to 0.

- **Public generics rejected an `interface`.** Twenty-five generic constraints
  across thirteen modules read `T extends Record<string, unknown>`, which an
  `interface` cannot satisfy because it has no implicit index signature. The
  identical shape therefore compiled or failed depending on whether it was
  declared with `type` or `interface`, while the runtime always accepted both.
  Affected `eventBus`, the `normalize` family, `machine`, `defineComponent`,
  `defineSlottedComponent`, `withProps`, `withDefaults`, `validateProps`,
  `defineStrictComponent`, `createSharedScope`, `wasm`, `createWasmBridge`,
  `offlineStore`, and others. All widened to `T extends object`; no
  implementation needed the index signature.
- **`globalStore` actions could not have typed payloads.** The action-map
  constraint required every action to *accept* `payload?: unknown`, making
  `add: (state, amount: number) => ...` unassignable and collapsing
  `Parameters<A[K]>[1]` — which `dispatch` already used — to `unknown`. Replaced
  with an exported `StoreActionMap<S>`.
- **`RouterLink` now returns `HTMLAnchorElement`.** It always builds an `<a>`,
  but was declared `HTMLElement`, so reading back the props it sets (`.href`,
  `.target`, `.rel`) did not type-check.
- **An action with an optional parameter can be applied without one.**
  `copyOnClick` is `ActionFn<(() => string) | undefined>`, but the two-argument
  `action()` overload demanded `ActionFn<void>`, so `action(el, copyOnClick)` did
  not compile despite being the documented usage. Fixed with an additive
  overload; the three-argument form is unchanged.
- **`bindField()` preserves the field's value type.** It documents itself as
  returning props ready to pass directly to a tag factory, but returned
  `value: () => unknown`, which does not satisfy the typed factories'
  `reactive<string>` — so every call site needed a cast. `BoundFieldProps<T>` is
  now generic (defaulting to `unknown`, so bare annotations still compile) and a
  single-value field spreads onto a tag factory with no cast. A
  `<select multiple>` still needs one: it binds `string[]` while
  `SelectProps.value` is `reactive<string>`, which needs wider tag-prop-type
  changes.

#### Internationalization

- **The active i18n locale is request-scoped during SSR.** It lived in a
  process-global signal, which is exactly right in a browser — one page, one
  active locale, shared across duplicated bundle copies — and exactly wrong on a
  server, where two overlapping renders overwrote each other: a request that
  paused across an `await` could resume and render the locale a *different*
  request had selected in the meantime. The locale now lives in the existing
  per-request `AsyncLocalStorage` store (no second one is created), so
  `setLocale()`, `getLocale()`, `t()`, `Trans()` and `hasTranslation()` all
  resolve the locale belonging to the current request, across every `await` and
  through nested contexts. An SSR request never writes the application default,
  so a success, a synchronous throw and an asynchronous rejection all leave the
  client locale untouched.

  Outside a request scope nothing changes: `setLocale()` updates the client
  locale reactively, duplicated bundle copies keep sharing it, and applications
  need no explicit i18n object. **Translation dictionaries remain
  application-global** — static data read identically by every request, so
  copying them per request would duplicate every message for no benefit;
  `registerTranslations()` merges and is visible everywhere, including when
  called from inside a request. A request that never calls `setLocale()` follows
  the application default, preserving the established `"en"` behaviour. On
  runtimes without `AsyncLocalStorage` the documented limitation is unchanged
  and now applies to the locale on exactly the same terms as the SSR flag.

- **i18n locale names and translation keys are treated as literal strings.**
  The locale registry and the translation dictionaries are objects, and lookups
  reached into them with bracket access and `in`, both of which walk the
  prototype chain. So every locale reported translations nobody registered —
  `hasTranslation("toString")` was `true` and `t("toString")` returned
  `Object.prototype.toString`, a function from a call declared to return a
  string — and the locale name `"__proto__"` was not a locale at all:
  `locales[locale] = dictionary` invoked the inherited `__proto__` setter, so the
  locale never appeared in `getAvailableLocales()` while every key of its
  dictionary read back as a locale of its own.

  Lookups now consult own properties only and publication goes through
  `Object.defineProperty`, so `__proto__`, `constructor`, `toString`,
  `hasOwnProperty` and the rest behave like any other name as both a locale and
  a translation key, registry prototypes are never modified, and an inherited
  property is never a translation. The guard is on the operations rather than on
  the initialiser, because the i18n singleton is deliberately shared across
  duplicated bundle copies: a copy that finds a registry created by an older one
  is protected on exactly the same terms.

  **A registered empty string is now preserved.** `t()` fell back to the key for
  any falsy message, so `registerTranslations(locale, { note: "" })` rendered
  `"note"` instead of a blank string; only a genuinely unregistered key falls
  back now, and `hasTranslation()` agrees with `t()` about which keys those are.
  Reentrant registration, request-scoped locale ownership, client locale
  reactivity and the application-global ownership of dictionaries are unchanged.

#### Optimistic UI, chunk loading, and device APIs

- **`optimisticList()` rows survive being temporarily hidden.** The row ledger
  held only the rows currently on screen, so a pending `remove()` took its rows
  *out* of it and carried copies in its own rollback list — one logical row with
  two representations. An operation that owned the row's value could then no
  longer find it: a confirmed `add` value was written nowhere and lost when the
  remove failed (`[1, 2]` instead of `[1, 20]`), and a failed `update` could not
  roll back, so the failed remove later reinstated the stale optimistic patch.
  Identity and visibility are now separate: the authoritative record lives as
  long as any operation may settle against it, so `add`/`update` land while the
  row is hidden, and a failed `remove` reinstates the row carrying whatever value
  it holds now. Records are retired by reference counting as their last holder
  settles, so nothing accumulates.

  Each operation runs in three ordered phases. PREPARE executes all
  user-controlled work — predicates, and the patch spread that runs a patch's
  property getters — and mutates nothing, so a throw there leaves the list
  untouched and idle rather than leaking `pending()` as true. COMMIT applies the
  change with no user code running and recomputes structural changes from the
  live list. PUBLISH writes `pending` and `items` in one batch, so a subscriber
  never sees one without the other and the operation is fully committed before
  any reentrant call it wakes can run. A reactive subscriber may therefore start
  an operation from inside another one: the outer operation can no longer erase
  the row the subscriber added, and an older update can no longer reclaim
  ownership of a row a newer reentrant update has taken.

  Broad operations are no longer quadratic. Row visibility is a flag rather than
  a scan of the visible array, and bulk restoration merges two already-sorted
  runs instead of reinserting rows one at a time. For `n` visible and `k`
  affected rows: membership O(1), reference release O(k), broad update O(n + k),
  bulk restoration O(n + k), publication O(n). A 20,000-row failed remove went
  from 8,300 ms to 13 ms on the development machine.

- **A failed `remove` restores rows in the correct relative order.** Rollback
  reinserted rows at their old ABSOLUTE index, so a concurrent successful removal
  of an earlier row displaced them — removing `B`,`D` from `["A","B","C","D"]`
  and then successfully removing `A` restored `["C","B","D"]`. Rows now carry a
  monotonic ordering key and are reinserted by ordered insert, so they return to
  their place relative to whatever is actually still present.

- **Chunk ownership is installed before any user callback runs.** `onLoadStart`
  fired before the pending entry existed, leaving a window in which the operation
  had publicly started but owned nothing: `invalidate(id)` or `clear()` called
  from that callback deleted a key with no entry and the load published anyway,
  and a reentrant same-key `load()` found no owner and started a second loader —
  which fired `onLoadStart` again, recursing 1889 deep in the reproduction — with
  the outer call then overwriting whatever ownership the nested ones established.
  The entry now goes in first, backed by a deferred the loader settles, so
  invalidating from `onLoadStart` really supersedes the load and a reentrant call
  shares it.

- **`wakeLock()` never reports active for a released sentinel.** The sentinel was
  installed and `active(true)` published without checking `released`, so a
  sentinel the platform had already released was reported as a held lock — and,
  worse, retained, which made `request()` treat the controller as already holding
  one and refuse to acquire a live replacement. Acquisition now checks `released`,
  attaches the listener, re-checks (a release in that gap fires with nobody
  subscribed), and only then publishes. A listener registration failure releases
  the sentinel rather than holding a handle it cannot track.

- **`optimisticList()` operations own rows, not the whole array.** Rollback used
  a single global version counter and a captured array snapshot, which is wrong
  in both directions: skipping the rollback (because a newer operation existed)
  left a failed operation's optimistic item on screen permanently — `[1,2,3]`,
  `add(4)`, `add(5)`, A fails produced `[1,2,3,4,5]` — while performing it
  discarded every change newer operations had made to rows the failing one never
  touched. The list is now a ledger of rows with stable ids and per-row operation
  ownership, so disjoint operations settle independently, an operation can only
  undo its own mutation, and where two touch the same row the later one wins.
  Row identity no longer falls back to `Object.is`, so duplicate primitives and
  duplicate object references address the correct occurrence — `[1]` plus an
  optimistic `add(1)` confirmed as `10` now yields `[1, 10]`, not `[10, 1]`.
  `items()` projects values only; no id or wrapper is observable.

- **Chunk invalidation is a publication barrier.** `invalidate(id)` and `clear()`
  left the pending map untouched, so an in-flight load could write a discarded
  value back into the cache after the fact, delete a newer pending entry, or be
  adopted by a post-invalidation `load()` that then never called its own loader.
  The pending entry is now the load's claim on the key: removing it revokes
  ownership, and a load publishes only if it still owns the key. Superseded work
  still settles for its original caller — nothing is cancelled, since the loader
  API takes no abort signal. `preload()` markers follow the same identity rule.

- **Chunk lifecycle callbacks can no longer change what a load did.** A throwing
  `onLoadEnd` turned a cached success into a rejection and then delivered its own
  exception to `onLoadError`, leaving the caller told "failed" while the cache
  held the value; a throwing `onLoadStart` stopped the load from starting at all.
  Callbacks now run contained, and their failures are reported through the
  runtime error pipeline instead of altering the operation.

- **`wakeLock()` cannot orphan a sentinel.** Overlapping requests acquired two
  native sentinels and kept only the last reference, leaving the other held with
  no way to release it; `release()` did not supersede a request already in
  flight, so a lock could reactivate after being given up; and a stale sentinel's
  `release` event cleared the state of the current one. Requests now share one
  in-flight acquisition, `release()`/`dispose()` revoke ownership before awaiting
  anything, and any sentinel arriving without ownership is released immediately.
  `dispose()` is idempotent and publishes nothing after disposal. Failed
  request/release operations are reported through the runtime error pipeline
  rather than `console.warn`, so application error handlers can observe them.

- **`viewTransition().isTransitioning()` describes the controller, not the last
  run to finish.** Two overlapping `start()` calls raced over one boolean, so the
  flag went false while an earlier transition was still running. It now stays
  true while any run is in flight and becomes false exactly when the last one
  settles, in any order; every caller keeps its own resolution or rejection.

#### Document head and attribute policy

- **URL-attribute classification in `Head()` is case-insensitive.** `head.ts`
  carried a private `new Set(["href", "src"])` and tested it against the
  AUTHORED attribute spelling. HTML attribute names are ASCII case-insensitive,
  so the browser reads `SRC` as `src` — but that lookup did not, and
  `Head({ script: [{ SRC: "data:text/javascript,…" }] })` skipped URL
  sanitization completely and appended a `<script>` a real browser fetched and
  executed. Both SSR paths, which lower-cased first, refused the identical
  value. Every classification — URL sinks, event handlers, `srcdoc`, duplicate
  detection — now runs on one canonical, deliberately ASCII-only fold
  (`canonicalAttrName`), because `String.prototype.toLowerCase` maps some
  non-ASCII code points *into* ASCII letters and the HTML parser does not.

- **Router SSR no longer carries its own URL sanitizer.** `sanitizeUrlLocal`
  described itself as mirroring `utils/sanitize.ts` but was a BLOCKLIST of four
  schemes where the canonical sanitizer is an ALLOWLIST, so router SSR emitted
  `file:`, `about:`, `chrome:` and every custom scheme that `Head()` and
  `renderToDocument` both refused. It is deleted; all three paths call the
  canonical `sanitizeAttributeString`.

- **A refused URL attribute is OMITTED, not published as `href=""`.** An empty
  URL attribute resolves against the current document — `<link href="">`
  references the page itself and `<script src="">` is a request, not a no-op —
  so an empty substitute is a different document from an absent attribute. The
  sanitization contract now distinguishes "accepted, possibly empty" from
  "rejected"; an empty string remains a legitimate value for inert text
  attributes like `content` and `id`. `setCanonical()` and `Head({ base })`
  follow the same rule, and a rejected update clears any previously accepted
  value rather than leaving a stale one standing.

- **`srcdoc` is refused by `Head()` too.** The client preserved it while both
  servers dropped it. The browser parses `srcdoc` as a nested HTML *document*,
  so escaping is the wrong layer, and the rule now applies identically on all
  three paths in every casing.

- **An entry with no effective attributes is dropped everywhere.** The client
  published an attribute-less `<meta>` where both servers emitted nothing. One
  shared answer, decided at the shared planning layer.

- **`Head()`, `renderToDocument()`, and `renderRouteToDocument()` share the
  policy itself, not merely a policy function.** The pipeline used to take the
  name filter and value sanitizer as parameters, so each target supplied its
  own and the three diverged in four separate ways. Only value resolution — the
  client has reactive getters, the servers do not — is parameterized now. The
  planned attribute map is keyed by canonical names, so client DOM and server
  HTML are exactly comparable; a table-driven parity suite asserts emitted
  status, attribute count, names, and values across all three.

#### Micro-apps, remote components, and infinite scroll

- **Removing an owned tree now disposes it.** `createMicroApp()` cleared its
  container with a bare `replaceChildren()`, which detaches nodes without
  running SibuJS teardown — so every effect, binding and listener inside the
  outgoing tree survived as an unreachable zombie firing against detached DOM,
  one leaked component tree per remount. Micro-app mount/unmount, remote
  component swaps, custom-element teardown, `DynamicComponent`, `DOMPool` reuse
  and the testing `render()` helpers all route through the disposal-aware
  replacement primitive now. Re-mounting a node that is already in the container
  keeps it alive rather than disposing the tree being reinstalled.
- **A remote component no longer instantiates after its owner is gone.**
  `defineRemoteComponent()`'s loader is an unbounded async gap — a route can
  change or a list row can be removed long before the module arrives — and the
  resolution built DOM and registered disposers inside a container nobody would
  ever dispose again. The resolved module is still cached after disposal, which
  is correct and deliberate: it is shared, immutable and expensive to fetch, so
  the next instance renders instantly. Only the instantiation is owner-scoped.
  The rejection path is guarded too: a disposed container no longer receives an
  error fallback.
- **`infiniteScroll()` no longer leaks an unhandled rejection.** The
  `IntersectionObserver` callback started an async `loadMore()` and dropped the
  promise, so a rejecting `onLoadMore` became an unhandled rejection — which
  crashes a Node SSR process and fires `window.onunhandledrejection` in a
  browser, for what is only a failed page of data. Failures are now contained
  and reported through the central runtime error pipeline (phase `"async"`),
  `loading` is always cleared, and a load settling after `dispose()` mutates
  nothing. `dispose()` clears `loading` itself rather than leaving it to a
  completion that is no longer permitted to write.

#### Browser and platform integrations

- **`wasm(url)` can express the origin policy its loader requires.**
  `loadWasmModule()` demands `allowedOrigins` or an explicit
  `unsafelyAllowAnyOrigin` opt-in for URL sources, and the public `wasm()`
  wrapper had no way to supply either — so every URL load was refused and the
  convenience API was unusable for its primary documented use case. `WasmConfig`
  now extends the loader's option type rather than copying a subset, so the two
  cannot drift again.
- **A keyed WASM load is genuinely one instance.** The cache stored only
  results, so two callers that both missed it before either finished each ran a
  full instantiation — and the documented singleton became two objects with two
  separate linear memories, one of them detached from every other holder.
  Concurrent loads now share an in-flight promise per key, and a failed load no
  longer poisons the key against a later retry.
- **`offlineStore` conflict strategies actually differ.** `conflictStrategy` was
  part of the exported adapter type and read nowhere; every adapter silently got
  client-wins. `client-wins` (still the default) discards a pulled record for any
  key with an unpushed local edit; `server-wins` lets the remote value win while
  *retaining* the queued change, since dropping it would turn a display-precedence
  choice into silent data loss; `manual` defers to a new `resolveConflict`
  resolver, and without one degrades to client-wins with a warning rather than
  guessing with unsynced data. The strategy union and the resolver's argument are
  now exported as `ConflictStrategy` and `SyncConflict`.
- **One `offlineStore` sync uses one adapter.** `attach()` landing mid-sync
  could split a single transaction across two backends — pushing through the old
  adapter and pulling through the new one, with the new one's conflict strategy
  applied to the old one's push results. The adapter is snapshotted for the whole
  operation; the next sync picks up the new one.
- **`serviceWorker()` no longer throws under SSR.** `"serviceWorker" in
  navigator` is a `TypeError` where `navigator` does not exist. The helper now
  reports an inert unsupported state instead.
- **A failed `unregister()` no longer detaches the service-worker wrapper.**
  `registration.unregister()` returns `false` when the browser declines — the
  worker is still installed and still controlling pages — but that was treated
  as teardown, permanently blinding the wrapper to a live worker: no update
  tracking, no registration, no way back. A failed unregister now changes
  nothing.
- **`unregister()` before the registration resolves no longer orphans it.** The
  call saw a null registration, reported "nothing to do", and the worker that
  landed a moment later stayed registered in the browser while SibuJS reported
  nothing at all. The request is now remembered and applied to the arriving
  registration.
- **`document.title` and `<base>` use owner-aware restoration.** Both are global
  singletons, and both were handled as if they were ordinary independently-owned
  tags. `Head()` never restored the title on dispose, so a page kept a title
  belonging to an unmounted component; `title()` kept a per-instance snapshot,
  which restores a stale value whenever three owners overlap and the middle one
  is disposed first — an everyday reordering, not a corner case. `Head` also
  deleted whatever `<base>` it found (typically the server-rendered one) and put
  nothing back, permanently changing how every relative URL on the page resolved.

  Both resources now use one shared owner stack: writes come from the current
  top, releasing a non-top owner changes nothing visible, and emptying the stack
  restores what was there before the first owner arrived. `Head({ title })` and
  `title()` contend for the same stack rather than two independent ones.
- **Scoped styles now cover descendants created after render.**
  `withScopedStyle()` stamped the scope attribute onto every element that existed
  at render time, which makes the contract "elements present at render time"
  rather than "this component's subtree": anything a signal, an `each()` row or a
  conditional inserted later was unmarked and rendered unstyled. Selectors are
  now anchored at the component root, so the DOM relationship does the matching
  and future descendants are included automatically. Pseudo-classes,
  pseudo-elements, combinators, media queries and keyframes are preserved, and
  the root remains selectable by its own rules.
- **`scrollRestoration({ mode: "auto" })` actually restores.** Auto mode
  attached a `popstate` listener that only ever *saved* — the documented
  save/restore behaviour was half implemented, and going Back never returned the
  viewport anywhere. It now tags history entries with their key, saves the entry
  being left, and restores the destination's position. A same-key pop is not
  treated as a departure, which would otherwise overwrite the stored position
  with the current one and destroy the value about to be restored. An unknown or
  absent destination key is a safe no-op. A `getKey` option integrates the
  feature with a router's own history identity.
- **Scoped-style selector lists are parsed, not regex-split.** The rewriter
  split selector preludes on every comma, but a comma is not a separator inside
  a functional pseudo-class (`:is(.a, .b)`), an attribute value
  (`[data-v=","]`), or a string. Those selectors were torn in half and each
  fragment scoped independently, producing CSS the engine either rejected or
  accepted with a different meaning — `:is(.a, .b)` became
  `[s] :is(.a, :is(.a[s],[s] .b), .b)[s]`, which selects neither arm. Splitting
  is now done by a scanner that tracks paren, bracket, quote, comment and escape
  state, and the stylesheet walk uses the same scanner to find rule boundaries,
  so `@media` / `@supports` / `@layer` recurse while `@keyframes` bodies are left
  alone without special-casing `from`/`to`/percentage stops.
- **One `unregister()` issues at most one native unregister.** On the pending
  path there were two callers of `registration.unregister()`: the arrival
  handler and the resumed public call. When the browser refused the first, the
  arrival handler correctly re-adopted the still-live registration and the
  resumed call then fired a second attempt at it. Unregistration is now a single
  owned in-flight operation with exactly one call site — concurrent callers join
  it, and the arrival handler hands the registration over instead of removing it
  itself. A registration that lands while a removal is outstanding is no longer
  published at all, so a worker about to be removed never transiently reports as
  ready.
- **`bindAttrs()` and `bindData()` types now describe the runtime.** Both
  excluded `null`/`undefined` while the runtime treats them as removal, so the
  documented behaviour was unreachable from type-checked code and the ordinary
  `() => user?.label` getter was a compile error. A shared `AttributeValue` /

#### Queries, mutations, and cancellation

  `AttributeSource` pair is now exported and used by both.
- **`clipboard()` and `permissions()` ignore completions after disposal.** A
  clipboard write can sit on a permission prompt indefinitely; one resolving
  after `dispose()` set state and armed a two-second timer against a torn-down
  subtree. `permissions()` guarded its success path but not its failure path, so
  a query rejecting after teardown still flipped a disposed controller to
  `"unsupported"`.

- **Retry cancellation now wins immediately.** A request that rejected *after*
  its `AbortSignal` had already aborted was still treated as a retryable
  failure: `shouldRetry` was consulted, `onRetry` fired, and the backoff was
  scheduled. The backoff itself then attached its `abort` listener without
  first checking `signal.aborted` — and a signal does not replay a past `abort`
  event — so cancellation was delayed by the entire delay, up to `maxDelay`.
  This affected every primitive built on `withRetry()` (`resource`, `query`,
  `infiniteQuery`, `mutation` and data loaders).

  Cancellation is now judged on both halves of the evidence: the signal, and the
  rejected value. An operation cancelled by a signal `withRetry()` does not hold
  — an inner `fetch` with its own controller, a timeout wrapper, a caller that
  composed its own abort — rejects with an `AbortError` while our signal reads
  as healthy, and was retried like any other failure. Such a rejection now
  bypasses `shouldRetry`, `onRetry` and the backoff, and propagates unchanged so
  the caller keeps their own error instance.
- **Data primitives now share one `AbortError` classifier.** `resource` and
  `mutation` recognised only `DOMException`, while `query` and `infiniteQuery`
  accepted any object named `AbortError`. A fetcher rejecting with an ordinary
  `Error` named `AbortError` was therefore silently ignored by two primitives
  and stored as application error state by the other two. Classification is by
  `name`, never by message: `new Error("AbortError")` remains a real failure.

  Classification also runs *before* normalization now. `mutation()` wrapped the
  thrown value in `new Error(String(err))` first, which keeps a message and
  discards everything else — `name` included. A cancellation carried on a plain
  object became `Error("[object Object]")` named `"Error"`, so the abort
  surfaced as a mutation failure: `error()` set, `onError` called, and a console
  warning from the fire-and-forget `mutate()` path. `mutateAsync()` rejects with
  the original `AbortError` value; ordinary failures are still normalized to an
  `Error`.
- **A cancelled mutation no longer stays permanently loading.** `mutation()`
  set `loading`/`status` on entry, and the `AbortError` branch rethrew before
  any terminal transition ran. That was invisible for the cancellations SibuJS
  itself causes — `reset()` and a superseding `mutate()` write the state on
  their way past — but when the *current* run's own `mutationFn` rejected an
  `AbortError`, nothing else was coming: the promise rejected and `loading()`
  stayed `true` forever, so a spinner bound to it never stopped.

  Cleanup is run-owned, not blanket: only the run that still holds the state may
  repair it, so a late superseded run cannot clear the newer run's loading
  state. A cancelled current run restores the last state the mutation actually
  settled into — `idle`, `success` or `error` — rather than forcing `idle`,
  because cancelling produced no verdict of its own: `success(data)` stays
  `success(data)` and `error(E)` stays `error(E)`. The baseline is tracked
  separately from the visible state, so a mutation started while another is
  still loading cannot adopt `"loading"` as its restore point and end up
  finished but in no terminal state at all. Cancellation still calls neither
  `onError` nor `onSettled`.

  `onMutate` now states its contract explicitly: ordinary exceptions fail the
  mutation, an `AbortError` is cancellation — the same rule `mutationFn`
  follows, so where a cancellation is raised does not change what it means.

#### Island hydration, links, and style sanitization

- **Progressive island hydration is idempotent.** `hydrateIslands()` and
  `hydrateProgressively()` selected candidates without consulting
  `data-sibu-hydrated`, and a hydrated island deliberately keeps its
  `data-sibu-island` marker — so a second pass over an overlapping root
  re-ran the factory and replaced the live subtree, destroying its state and
  listeners. Both now skip already-hydrated islands, at candidate discovery and
  again when an asynchronous trigger actually fires.
- **`RouterLink` preserves native behaviour for `download` anchors.** A link
  carrying `download` was `preventDefault()`ed and routed, so the file never
  downloaded and a history entry appeared for a URL that was never a view.
  Presence is what counts — `download`, `download=""` and `download="a.pdf"`
  all mean the same thing.
- **String and reactive-string `style` props are sanitized like object styles.**
  Object-valued styles ran every property through the CSS sanitizer while the
  string forms went straight to `setAttribute("style", …)`, making the string
  form a silent escape hatch (`url()` exfiltration, `expression()`, `behavior:`,
  `-moz-binding`, `@import`). All whole-style-string sinks — the tag factory,
  reactive bindings, `html``  `` expressions, prop spreads and `RouterLink` —
  now share one declaration-list policy.

  Two observable consequences: a `url()` in a string style is now dropped, as it
  already was in the object form; and string styles are re-serialized
  canonically by the CSS parser, so `"width:10px"` reads back as `width: 10px`.
- **The CSS sanitizer understands every escape form, not just hex.** Blocked
  constructs are matched against literal spellings (`url(`, `expression(`,
  `@import`), which is only sound once the value has been reduced to what the
  CSS parser sees. Only hex escapes (`\75 rl(…)`) were decoded, so the other two
  productions of the escape grammar carried a payload straight through: simple
  escapes, where `\` before any non-hex character *is* that character
  (`u\rl(https://…)`), and escaped newlines, where `\` and the newline both
  vanish. Every browser resolves all three spellings identically; now so does
  the sanitizer, for object, string and reactive styles alike. Decoding is used
  only to inspect — the value written to CSS is still the author's original
  text, so legitimate escapes such as `content: "\201C"` are unchanged.
- **Server-rendered `style` attributes are sanitized.** `renderToString()`,
  `renderToStream()` (and so `renderToReadableStream()` /
  `renderToSuspenseStream()`) and `renderToDocument()` each carried their own
  inline attribute rules covering URLs only, so `style` was emitted verbatim —
  including into `<body style="…">` via `bodyAttrs`, and into `<meta>` / `<link>`
  entries. The same component was filtered in the browser and an exfiltration
  vector from the server. All three serializers now apply one shared policy,
  before HTML escaping, and drop the attribute entirely when no declaration
  survives rather than emitting an empty `style=""`.

A correctness and release-hardening pass over the reactive core, keyed lists,
error reporting and packaging. No public API was removed or renamed; one new
export and one additive field were added.

#### Reactive core

- **Derived values no longer notify downstream effects when the derived output
  stayed equal.** Previously an effect whose only relevant dependency was a
  `derived()` re-ran whenever an *upstream source* changed, even if the derived
  recomputed to the same value — so `derived(() => value() % 2)` re-ran its
  subscribers on every write. `equals` deduplicated notifications but never
  actually stopped propagation. This applies to the default `Object.is`
  comparator and to a custom `equals`, through multi-level chains, diamonds and
  batches.
- **Keyed `each()` rows no longer display stale data when an item is replaced
  under the same key.** Replacing `{id: 1, name: "Alice"}` with
  `{id: 1, name: "Bob"}` now updates the row's contents while keeping the same
  DOM node. Each row owns reactive `item()` / `index()` cells that
  reconciliation writes on reuse; `render` still runs exactly once per key, and
  DOM identity across reorders is unchanged.
- **`index()` inside a keyed row is now reactive**, so reordering a list updates
  index-derived content without recreating rows.
- **Application exceptions thrown from an effect or binding re-run are now
  reported in production.** They were caught to protect the notification drain
  and then discarded unless a development flag was set, making a thrown
  exception indistinguishable from success. They are still contained — one
  broken subscriber cannot freeze unrelated bindings — but they are no longer
  silent.
- **A runaway subscriber no longer discards unrelated pending work.** Tripping
  the cycle guard now quarantines the offending subscriber for the rest of that
  update while every other queued subscriber still runs; previously the entire
  drain was aborted.
- **Long but finite update cascades are no longer misreported as cycles.** A
  legitimate cascade deeper than the old 50-run guard was aborted mid-flight,
  leaving the un-drained tail of the graph holding wrong values. The guard is
  now 1 000 runs, and `maxDrainIterations` remains the absolute backstop.

#### URL and srcset sanitization

- **`sanitizeUrl()` no longer rewrites legitimate URLs.** The aggressively
  stripped copy used to detect obfuscated schemes (`java\tscript:`) was being
  returned to the caller, so `mailto:a@b.com?subject=Hello World` came back as
  `...HelloWorld`. Detection and output are now separate: dangerous schemes are
  still rejected, and safe URLs keep their interior characters.
- **`sanitizeSrcset()` now drops candidates with a malformed descriptor**,
  closing a case where a whitespace-obfuscated scheme survived because the
  candidate split left the dangerous half in the descriptor position.
- **The README's CDN snippet pointed at a file the build does not emit**
  (`dist/sibu.global.js`); the correct artifact is `dist/cdn.global.js`.

#### Runtime error handling and ErrorBoundary

- **Runtime errors associated with a DOM node were treated as handled merely
  because an `ErrorBoundary` event had been dispatched.** If no boundary was
  mounted above the node, the event went nowhere and reporting stopped anyway —
  so the configured runtime error handler and the `console.error` fallback were
  both skipped and the failure disappeared. A boundary must now explicitly claim
  an error (the event is cancelable; claiming means `preventDefault()`), and an
  unclaimed error falls through to the handler or the console.
- **Keyed-list render failures bypassed the central runtime error pipeline.**
  `each()` dispatched its own boundary event and otherwise warned only in
  development, so a row that failed to render in production with no boundary
  mounted was silent. The same applied to `Portal`, `lazy()`/`Suspense`,
  reactive bindings (`bindChildNode`, `bindTextNode`, `bindAttribute`,
  `bindDynamic`), lifecycle hooks (`onMount`/`onUnmount`) and node disposers —
  all of which now report through the one pipeline.
- **Runtime error handlers are now shared between compatible duplicate SibuJS
  runtime instances.** The handler was module-local, so when a bundler
  materialized SibuJS twice, a handler installed through one copy was invisible
  to the shared reactive engine owned by the other, and application telemetry
  silently never fired.
- **Reactive-binding failures were reported as phase `"effect"`.** The scheduler
  invokes effects and DOM bindings through the same call and had no way to tell
  them apart; bindings now report phase `"binding"` and carry the node they own,
  which is also what lets an `ErrorBoundary` catch a binding that throws on a
  later update rather than only during the initial render.
- **An effect that hit its rerun safety ceiling was not reported when
  `__SIBU_DEV_WARN__` was `false`.** That flag controls optional developer
  diagnostics; reaching a safety ceiling means the framework forcibly stopped
  the user's work, which stays observable regardless.
- **`ErrorBoundary` fallback state was shared between independent boundaries.**
  Fallbacks were memoized in a module-global cache keyed by the fallback
  function plus `error.message`, and the cached entry closed over one specific
  boundary's `Error` and `retry`. Two boundaries sharing a fallback function —
  the idiomatic way to use one — whose errors carried the same message therefore
  aliased each other: a boundary could render another boundary's Error and be
  handed another boundary's `retry`, and retrying one wiped the other's state.
  The cache is removed; each boundary owns its error, its retry and its rendered
  fallback. Sharing one fallback function across an application is safe.
  (The cache also never memoized any rendering — it cached a closure that was
  invoked on every call — so nothing observable is lost.)
- **Errors thrown by `ErrorBoundary` `resetKeys` getters now use the central
  runtime error pipeline.** They previously went to `console.warn` only, which
  no configured runtime error handler could observe.
- **`ErrorBoundary` `resetKeys` now compare selected VALUES, not dependency
  invalidation.** A getter is a selector, and re-running because its source was
  replaced is not a change. `resetKeys: [() => route().pathname]` no longer
  recovers a failed boundary when an unrelated field of the route object is
  written; values are compared with `Object.is` against the values captured
  when the error was caught.
- **A reset-key change that causes an error no longer immediately resets the
  newly-failed boundary.** Reset keys are now watched only while the boundary is
  failed, with the values at the moment of failure as the baseline — so a single
  update that both moves a reset key and makes the children throw leaves the
  boundary failed. Only changes observed after the failure trigger recovery.
  Because the getters are evaluated only during a failed episode, a getter that
  throws is now reported when the boundary fails rather than at construction.
- **`ErrorBoundary` `resetKeys` watchers no longer subscribe to the boundary's
  own error state.** Once a reset key had changed while the boundary was
  healthy, the watcher became a subscriber of that boundary's error signal, so a
  later unrelated failure re-ran the watcher and immediately reset itself — the
  fallback appeared and vanished without any reset key changing. Reset keys are
  triggers; the current error is only inspected when a trigger fires.
- **Reporting an error no longer runs inside the failing subscriber's tracking
  context.** An `ErrorBoundary` listener (or an application handler) that reads
  a signal while deciding what to do would otherwise have that read attributed
  to the throwing subscriber — which subscribed the failing binding to the
  boundary's own error signal, re-ran it, and reported the same failure twice.

### Security

- **Meta-refresh directives are structurally parsed, and client/SSR share one
  policy.** Dangerous destinations were detected by asking whether the
  lower-cased `content` contained `url=javascript:` (plus three sibling
  schemes). That recognises one spelling of a grammar the browser accepts in
  many: `0; url = javascript:…`, `0;URL=JAVASCRIPT:…`, `0;url='javascript:…'`,
  and tab-separated forms all produced a live redirect the check never saw.

  The destination is now extracted by a parser and handed to `sanitizeUrl()` —
  the same protocol authority every other URL sink uses — instead of being
  pattern-matched. Directives the parser cannot read unambiguously (unterminated
  quotes, competing `url=` assignments, non-numeric delays, trailing junk, empty
  destinations) are dropped rather than emitted on the basis that no forbidden
  substring appeared. This is deliberately stricter than a browser and does not
  claim parity with the WHATWG algorithm.

  `head.ts` and `ssr.ts` previously carried separate copies of the rule, so a fix
  to either would have diverged from the other; both now call
  `utils/metaRefresh.ts`, as does router SSR.

- **Reactive `Head()` meta entries are validated as complete snapshots.** One
  effect per reactive *attribute* meant each write was judged alone, so a
  reactive `http-equiv` flipping to `"refresh"` could activate static `content`
  that had been accepted only because the entry was not a refresh at the time.
  There is now one effect per entry: it resolves every attribute and validates
  the assembled snapshot — and a snapshot that fails validation withdraws the
  element rather than blanking one attribute.

- **`Head()` meta publication is a swap, not a reconciliation.** Validating the
  whole snapshot was not enough while the snapshot was then applied to a
  *connected* element one attribute at a time. Updating an entry from
  `http-equiv="x-custom"` + a forbidden `content` to an entirely valid
  `http-equiv="refresh"` + `content="5;url=/safe"` wrote the new `http-equiv`
  while the old content was still in place, so the document briefly held a live
  `<meta http-equiv="refresh" content="0;url=javascript:…">` that no snapshot ever
  approved. Reordering the writes would only move the hole — attribute order is
  not a security mechanism. An accepted snapshot is now materialised on a fresh
  element while detached and published with a single `replaceWith()`, and the
  managed-element reference is updated in the same step so disposal never leaks a
  replaced node.

- **Native meta-refresh directives managed by client-side `Head()` must be
  static.** A browser processes a refresh when the element is *inserted*, and
  removing or replacing it afterwards is not a defined way to cancel the
  scheduled navigation. A reactive entry therefore never publishes a snapshot
  whose effective `http-equiv` is `refresh` — even when the destination is
  allowed, because what cannot be withdrawn must not be handed over. This is a
  publication rule, not a parse rule: the snapshot is still parsed and still
  refused outright when the directive is dangerous.

  **Behaviour change:** `Head({ meta: [{ "http-equiv": "refresh", content: () => …
  }] })` and the reactive-`http-equiv` equivalent no longer insert a refresh
  element. Fully static refresh directives are unaffected, and every other
  reactive meta entry — description, keywords, Open Graph, non-refresh
  `http-equiv` — behaves exactly as before. Documentation no longer claims that
  detaching an inserted refresh cancels its navigation.

- **Duplicate case-insensitive attribute names in a meta entry are rejected.**
  `{ "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", … }` is legal
  JavaScript; a first-match lookup validated one spelling while the DOM committed
  the other. Rejection was chosen over last-write-wins because it removes the
  class of bug rather than re-parameterising it.

- **`Head()`, `renderToDocument()`, and `renderRouteToDocument()` run one meta
  pipeline in one order.** Sharing a policy function was not the same as sharing
  a decision: the client filtered unsafe attribute names *before* checking for
  duplicates while the servers checked the raw record first, so
  `{ name: "description", content: "ok", onload: "a", ONLOAD: "b" }` was emitted
  by the client and dropped by both servers. `planMetaEntry` now fixes the order
  for all three — raw duplicate names, name filtering, value resolution,
  sanitization, then the refresh verdict on the effective snapshot — so the value
  inspected by the policy is exactly the value committed, and the three paths
  agree on whether an entry exists and on its effective attributes.

- **`srcdoc` is refused by every generic attribute API, and omitted by SSR.**
  The shared attribute policy classified attributes into event handlers, URLs,
  `srcset`, `style`, and "everything else, which `setAttribute` stores as inert
  text". That last claim is false for `<iframe srcdoc>`: the browser decodes the
  value and parses it as a complete nested HTML document, and without a sandbox
  its scripts run with the embedding page's origin.

  Attribute escaping is not a weaker defence here, it is the wrong layer —
  `srcdoc="&lt;script&gt;…"` is correctly escaped and still becomes `<script>…`
  once parsed as a document. So the generic writers refuse the attribute
  outright and, as with `on*`, remove any pre-existing value rather than merely
  declining to add one. The rule lives in one place
  (`isHtmlContentAttribute()`) and is consulted by the tag factory,
  `bindAttribute`/`bindDynamic`, `bindAttrs`, `enhance().attr()`, `svgElement`,
  the `html` template, and all four SSR attribute serializers.

  Sanitizing arbitrary HTML is deliberately not attempted, and `TrustedHTML`
  does not unlock it: that type is a compile-time brand with no runtime
  identity. A trusted-document API would need a runtime-verifiable wrapper or
  browser Trusted Types, and is not part of this change.

- **Dynamic `html` template attributes now use the shared attribute policy.**
  The tagged-template executor carried its own rules — `srcset`, then URL
  attributes, then write — which was the shared list minus `style`. So
  ``html`<div style=${untrusted}>` `` bypassed the declaration-list sanitizer,
  contradicting the sanitizer's own documented invariant, and would have
  bypassed the new `srcdoc` rule too. Both dynamic forms (a single expression,
  and a mixed attribute assembled from statics and expressions) now commit
  through the shared primitive, so a refused value also reconciles whatever was
  already on the element. Fully static template text is unchanged: an attribute
  the developer typed into their own source stays developer-controlled.

- **Static and reactive attribute writes now share one security policy.** The
  same value reached opposite verdicts depending only on the shape of the
  expression: `bindAttrs(a, { href: url })` wrote `javascript:` straight to the
  DOM, while the identical `bindAttrs(a, { href: () => url })` blocked it. The
  divergence — not any single missing check — was the vulnerability, because a
  routine refactor between the two forms silently changed an application's
  security posture. The same gap ran between the HTML tag factory and
  `svgElement()`, which turned an `onload` string into a live event handler that
  the equivalent HTML call had always refused.

  Every public attribute writer now commits through one primitive: the tag
  factory, `bindAttribute`/`bindDynamic`, `bindAttrs`/`bindBoolAttr`/`bindData`,
  `svgElement()`, and `enhance()`'s reactive `attr()`. `on*` strings are refused
  everywhere, URL attributes go through the protocol allowlist, `srcset` is
  validated per candidate, and `style` goes through the declaration-list
  sanitizer. Function-valued `on*` props keep their existing meaning —
  `addEventListener`, never an attribute. The policy itself is unchanged; what
  changed is that no writer can skip it.
- **`svgElement()` writes `xlink:href` in the xlink namespace.** A plain
  `setAttribute` produced an attribute whose literal name contained a colon and
  whose namespace was null, which SVG renderers ignore — so the reference
  silently failed to resolve while also bypassing URL filtering.
- **`enhance()`'s reactive `attr()` is no longer a raw sink.** Its value is a
  runtime getter at the same trust level as any other reactive binding, but it
  wrote through unfiltered, making progressive enhancement the one public path
  where a `javascript:` URL, an unsafe `style` list, or an `on*` handler string
  still reached the DOM.
- **Attribute security is now a postcondition on the managed attribute.** These
  APIs attach to DOM that already exists — server markup, third-party widgets,
  anything `enhance()` is pointed at — and two paths let a pre-existing
  violation survive. `enhance().attr()` compared its RAW desired value against
  the RAW attribute and skipped the write when they matched, so
  `<a href="javascript:…">` re-bound to that same string never reached the
  sanitizer at all. And a refused `on*` value left any existing
  `onclick`/`onload` content attribute in place: the writer had declined to add
  a handler while the page still had one.

  Write elision now lives inside the shared primitive and compares the
  POST-POLICY result, so no caller can skip the sanitizer by pre-comparing; and
  a binding that names an `on*` slot clears that slot rather than merely
  refusing it. Taking ownership of an attribute now means governing it.
- **IDL synchronisation is case-insensitive for HTML attributes.** HTML
  attribute names are case-insensitive, but the decision to write `value` /
  `checked` / `disabled` / `selected` through the live IDL property was
  case-sensitive — so a binding declared as `"VALUE"`, which the browser treats
  as exactly `value`, fell back to content-attribute semantics and left a dirtied
  control showing stale state. Normalisation is HTML-only: SVG attribute names
  are case-sensitive, and `viewBox` / `preserveAspectRatio` / `patternUnits`
  would be destroyed by folding them.

### Documented

Behaviours that are deliberate but were easy to misread. Full detail lives in
`docs/architecture/` and `docs/hardening/`.

- **Hydration replaces server DOM rather than adopting it.** Node identity is
  not preserved, and pre-hydration user input, checkbox state, and focus are
  discarded. The trade is real in both directions: partial-adoption mismatch
  bugs are structurally impossible, but SSR here buys first-paint HTML, not
  work-sharing between server and client. The `hydrate()` docstring described
  adoption and has been corrected.
- **`context()` is application-global** — not subtree-scoped and not SSR
  request-scoped, so concurrent server requests can observe each other's values.
  Development builds now warn when it is used during SSR and point to the
  alternatives.
- **`withContext()` scopes synchronous execution only.** The previous value is
  restored when the callback returns, which for an async callback is when it
  returns its promise. Development builds warn on an async callback. A
  promise-aware restore was deliberately not adopted: because the value is
  global it would fix the single-callback case while leaving overlapping async
  scopes equally broken, making the hazard harder to notice.
- **SSR requires a DOM implementation on the server** (jsdom, happy-dom,
  linkedom). Server-side *routing* is DOM-free; server-side *rendering* is not.
- **`renderToSuspenseStream()` waits for all boundaries before flushing any**, so
  streaming delivers an early shell plus one batched flush rather than
  incremental per-boundary delivery.
- **SSR Suspense renders its fallback on rejection or timeout**, so a failed
  boundary is indistinguishable from a loading one in the markup.
- **`withSSR()` is not request-scoped** — use `runInSSRContext()` for anything
  serving concurrent requests.
- **Derived chains are stack-bounded** at roughly 2 000–3 000 links, inherent to
  lazy pull-based evaluation. `dispose()` has no comparable limit; it walks
  iteratively.
- **Plain `<a href>` is never intercepted.** SibuJS installs no global click
  handler; only `RouterLink` intercepts.
- The README no longer claims "no diffing, no reconciliation" — keyed `each()`
  legitimately reconciles its own DOM range. It now says there is no Virtual DOM
  and no component-tree reconciliation, and that keyed collections reconcile only
  the range they own.
- **`enhance()` rollback covers framework-owned resources only.** A failed setup
  releases what was registered through the context — `ctx.on`, `ctx.text`,
  `ctx.attr`, `ctx.classed`, `ctx.show`, `ctx.model`, `ctx.cleanup`, and a
  cleanup returned from setup. Direct `innerHTML` writes, application-object
  mutation, in-flight requests and other side effects performed outside those
  helpers are not reversed, because they cannot be generically; register their
  undo with `ctx.cleanup()` as setup proceeds.
- **`data-sibu-enhanced` means "currently owns an active enhancement"**, not
  "has ever been enhanced", and is not public API. `data-sibu-hydrated` is a
  different kind of marker — hydration provenance, gating nothing — and is
  deliberately *not* cleared on disposal.

### Testing

The suite expanded substantially across the 4.0 hardening cycle — from 3 998
tests at the start of it to 4 651 at the time of tagging `4.0.0-rc.1` — plus
real-browser coverage across **Chromium, Firefox, and WebKit** (there was none
for routing, hydration, or SSR Suspense before). Beyond per-bug regressions, the
new coverage includes
seeded differential testing of keyed reconciliation against an external
reference model, a reactive-runtime torture suite, leak detection that asserts
live-binding counts return to baseline without relying on garbage collection,
seeded model testing for the router, query, and SSR escaping, cross-request SSR
isolation under hostile interleaving, and hostile-input escaping for both
streamed and non-streamed output.

New tooling, all opt-in and excluded from the default test loop:

- `npm run test:soak` (and `test:soak:gc`) — long-running lifecycle and SSR soak
  suites for memory behaviour under sustained load.
- `npm run typecheck` / `typecheck:tests` — type checking split so test-only
  types are verified separately from the shipped surface.
- `npm run certify:rc` — a release-candidate check that runs an export audit and
  a bundler matrix against minimal probe fixtures, verifying that subpath
  imports pull in only what they should.

---

#### Release certification

The package is now certified the way a consumer receives it — installed from a
real `npm pack` tarball into throwaway projects, never a workspace link.

- **`npm run certify:rc`** runs every release gate and reports each as PASS,
  FAIL, NOT SUPPORTED, or NOT TESTED. A gate that could not run is never
  reported as a pass.
- **Node support matrix** (`scripts/certify/node-matrix.mjs`) executes the
  declared minimum *exactly* plus the current release lines — Node 22.3.0, 22.x,
  24.x — each against the packed tarball, in both ESM and CommonJS. A version
  with any gate unrun is reported INCOMPLETE.
- **Engine-floor probe** (`scripts/certify/node-probes/engine-floor.mjs`)
  documents why 22.3.0 is the floor by measuring the boundary rather than
  asserting a version string: Node 22.2.0 reports isolation UNSUPPORTED, 22.3.0
  SUPPORTED. It fails if capability and behaviour ever disagree.
- **Bundler matrix** — Vite, Rollup, esbuild and Webpack each build, run, and
  exit cleanly from the packed tarball, with tree-shaking and bundle size
  recorded. Browser-target bundles are verified to run with no `process` global.
- **Subpath export audit** — every declared export resolves, imports, exposes
  types, starts no timers, installs no listeners, and creates no new globals.
- **Seeded model fuzzing** for the query cache and the router, and security
  fuzzing for every SSR output path. Deterministic seeds, so a failure replays
  exactly; no `Math.random()` in CI.
- **Soak suite** (`npm run test:soak`) for lifecycle, router, query and SSR
  request isolation, asserting framework counters return to baseline rather than
  relying on heap size.
- **Vacuity guards** throughout the fuzz and soak suites, which fail if the
  interesting path was never exercised. Several tests that passed while testing
  nothing were found and fixed this way.
- **CI** now runs source and test typechecks as gates, and a Node matrix pinned
  to `engines.node`. Large-list stress tests were given explicit timeouts: they
  assert correctness, not throughput, and the default budget made them fail on a
  loaded machine.

---

## [3.4.1] — 2026-07-07

A router correctness fix. No breaking changes.

### Fixed

- **The initial route now resolves its match on load** — the router seeds `currentRoute` with an uninitialized placeholder (`matched: []`) and then navigates to the current location on init. For the root path `/` — and any path whose `path`/`params`/`query`/`hash` coincided with that placeholder — `isSameRoute` treated the first navigation as a duplicate and discarded the real match, so `route().matched` stayed empty forever and `Outlet` (which renders a nested child only when `matched.length >= 2`) rendered nothing at `/`. `isSameRoute` now treats a placeholder that resolved to no match as never equal to a target that resolved to a real one, so the first navigation commits. The deferred initial navigation is additionally skipped when the app already issued its own navigation before the router finished initializing, so it can no longer clobber a route the app set first.

---

## [3.4.0] — 2026-06-26

Reactive islands for HTML-first apps — a third rendering mode that attaches
fine-grained reactivity to server-rendered HTML with **no build step**, no JSX,
no compiler, and no dependencies. The whole islands runtime is ~5.2 KB gzipped.
Additive; nothing existing changes.

### Added

- **`enhance(target, setup)`** — attach reactivity to *existing* DOM without
  re-rendering it (the third mode alongside `mount` and `hydrate`, which replace
  markup). The setup receives an `EnhanceContext` to drive server markup in
  place: `text`, `attr` (a11y-correct literal booleans), `classed`, `show`
  (toggles the standard `hidden` property, so it reveals server-`hidden`
  elements), `model` (two-way; checkbox / number / `<select multiple>`), `on`,
  `ref`/`refs`, and `cleanup`. Targets resolve via `@name` → `data-ref="name"`
  or a raw selector. Returns a dispose that's also tied to the element. Plus
  `enhanceAll(selector, setup)`.
- **Island runtime** — `registerIsland(name, setup)` + `mountIslands(root?)`.
  Declare islands in server HTML with `data-sibu-island="name"` and choose *when*
  each activates via `data-sibu-load`: `load` · `idle` · `visible` ·
  `interaction` · `media` (with `data-sibu-media`). `mountIslands()` wires the
  whole page in one call and returns a cleanup.
- **Lazy island code** — `lazyIsland(() => import("./island.js"))` fetches an
  island's module only when it activates, so a page ships ~0 JS for islands that
  never trigger.
- The whole workflow is exported from the package root and the `window.Sibu` CDN
  global, so it runs from a single `<script>` tag. Runnable examples:
  `examples/islands.html` and `examples/islands-strategies.html` (a real-browser
  smoke test for every strategy); guide: `docs/islands.md`; size benchmark:
  `bench/islands-size.mjs`.

Robustness: `enhance` skips no-op writes so static content is never re-painted
(no hydration flash when signals are seeded from the server value); re-enhancing
the same element is refused; a failing island's setup is isolated so it can't
take down the rest of the page; and a failed lazy `import()` is reported rather
than surfacing as an unhandled rejection. Every activation strategy — plus lazy
code-loading over HTTP — is validated in **Chromium, Firefox, and WebKit**
(Playwright, `npm run test:browser`) in addition to the jsdom unit tests.

---

## [3.3.3] — 2026-06-26

A hardening pass across the non-core subsystems (`ui`, `widgets`, `components`, `plugins`, `data`, `platform`, `patterns`, `performance`, `devtools`): correctness fixes, memory-leak plugs, SSR-safety guards, and accessibility improvements. No breaking changes.

### Added

- **`bindField` reflects an array back to `<select multiple>`** — the field's array value is now written onto each option's `selected` state on render and on update. (3.3.2 added the read side; this completes the two-way binding.)
- **`captureSignalGraph()` returns a real node inventory** — the devtools hook now implements `getSignalNodes()`, so the snapshot reports live signals/derived/effects (id, name, kind, current value) instead of always being empty. Dependency edges are not yet tracked.
- **`prefersReducedMotion()`** is now exported from `reducedMotion` (the one-shot check was previously duplicated privately in the spring/preset helpers).
- **`RouterLink` accepts positional children** — `RouterLink(props, children)` matches the framework's children convention; the `nodes` prop is kept as a deprecated alias.

### Fixed

- **Teardown-tied memory leaks** — `Head()`, the router's route outlets (`Route` / `KeepAliveRoute` / `Outlet`), `transition()`, and `hover()` now release their injected elements / cached subtrees / timers / listeners when their element or subtree is disposed, instead of living for the page's lifetime.
- **SSR no longer crashes** in `persisted()`, the priority scheduler, `stream()` / `socket()`, the router constructor (`createMemoryRouter`), `scrollRestoration()`, and `battery()` — each guards the browser global it touches and degrades gracefully instead of throwing a `ReferenceError`.
- **Devtools trace profiler** — `stop()` / `stopTrace()` no longer throw; the hook's `on()` now returns a working unsubscribe, so listeners are removed instead of leaking.
- **`form().isDirty`** no longer reports a field as dirty when an array/object value is unchanged (e.g. a multi-select with `initial: []`).
- **`createAction().submit`** — a slow earlier submission can no longer overwrite the result of a newer one (run-sequenced state updates).
- **`inputMask`** caret restoration — fixed mis-counting of literal characters for `*` masks and patterns with a leading literal.
- **`pagination`** clamps the current page reactively when the item count shrinks, so indices stay in bounds.
- **`infiniteScroll`** re-checks intersection after loading, so it doesn't stall when appended content doesn't push the sentinel out of view.
- **`lazyModule`** caches a loader that resolves to `undefined`/falsy instead of re-invoking it on every `get()`.
- **`normalize`** — child relations default to `id` instead of inheriting the parent's custom `idKey` (which produced `String(undefined)` ids).
- **Route matching is specificity-ordered** — a broad parameter route can no longer shadow a more specific route registered after it.
- Smaller fixes: the test `mockFetch` tolerates non-JSON request bodies; the a11y checker no longer exempts the literal string `"undefined"` from ARIA value validation.

### Accessibility

- **`Loading`** exposes `role="status"` + `aria-live="polite"` and a default label, so it is announced to screen readers.
- **`datePicker`** gives its grid an accessible name (the displayed month) and moves real focus to follow the roving tabindex during keyboard navigation.
- **Widget `bind()` is reversible** — `Combobox`, `Select`, and `datePicker` restore the `role` / `aria-*` / `id` / `tabindex` they set when torn down (matching `Accordion` / `Tabs` / `Popover`).
- **`Combobox`** no longer races a blur-close against an option click (a pointer-down inside the listbox keeps the input focused).
- **`contentEditable`** can be scoped to an editor element so its formatting commands ignore selections elsewhere on the page.

### Changed

- Internal coordination state for several modules (the `plugin` default registry, the `devtools` session, and the WASM / microfrontend module caches) is now shared across duplicate runtime copies, extending the 3.3.1/3.3.2 first-copy-wins sweep.
- `ErrorDisplay` reads dev-mode state at render time rather than at module load, so a runtime-configured dev flag is respected.

---

## [3.3.2] — 2026-06-26

Continues the duplicate-runtime hardening from 3.3.1, plus two small additive enhancements. No breaking changes.

### Added

- **Name-based action registry** — register reusable actions under a string name with `registerAction(name, fn)`, look them up with `getAction(name)`, or apply one directly by name: `action(el, "longPress", { duration: 500, callback })`. The built-in actions (`clickOutside`, `longPress`, `copyOnClick`, `autoResize`, `trapFocus`) are auto-registered under their export names. The registry is shared across duplicate runtime copies (same first-copy-wins mechanism as the reactive core).
- **`bindField` supports `<select multiple>`** — a change on a multiple-select now sets the bound field to the array of selected option values (via `selectedOptions`) instead of just the first. Single selects, text inputs, and checkboxes are unchanged.

### Fixed

- **`createId()` no longer collides across a duplicated runtime** — the unique-id counter is now shared across copies (the same first-copy-wins mechanism 3.3.1 introduced for the reactive core), so two copies can't both hand out `sibu-1`. This prevents broken a11y associations (`aria-labelledby`, `for` + `id`) and SSR hydration mismatches when a bundler duplicates the module.
- **SSR mode is consistent across a duplicated runtime** — the SSR flag/context (AsyncLocalStorage + fallback store) is now shared, so `enableSSR()` taking effect in one copy is observed by `isSSR()` in another. Previously a split could let client-only side effects run during a server render, or leak per-request state across copies.
- **The router survives a duplicated runtime** — the global router instance is now shared across copies, so navigation, `Outlet`, and `Link` helpers bundled into a second copy of the `plugins` chunk see the router created by `createRouter()` in the first copy, instead of throwing "Router not initialized."

### Changed

- **Duplicate-runtime dev warning now reports real versions** — the warning added in 3.3.1 now prints the actual package version (e.g. `active: 3.3.2, duplicate: …`) instead of `dev`, making mixed-version duplication easier to diagnose. Dev-only; stripped from production builds.

---

## [3.3.1] — 2026-06-26

A robustness release. No breaking changes; no API or behavior change for normal usage.

### Fixed

- **Reactivity survives a duplicated runtime** — when a bundler materializes the reactive-core module more than once on a page (e.g. dependency pre-bundling in Vite/esbuild, which can serve the same internal chunk twice — once with an `?v=<hash>` query and once raw), `signal()` writes and reactive bindings landed in two independent worlds: a write notified one copy's queue while a binding had tracked itself through the other's. The binding then silently stopped updating, with no error thrown. The runtime now routes every duplicate copy through the first one loaded on the page, so reactivity keeps working regardless of how many copies a bundler emits — and the hot path is unchanged, so single-instance performance is identical. Raw ESM usage was never affected and is unchanged.

### Added

- **Dev warning for duplicated runtimes** — in development, loading a second copy of the reactive runtime now logs a one-time, actionable warning explaining how to de-duplicate (e.g. Vite `optimizeDeps.exclude: ['sibujs']` or `resolve.dedupe: ['sibujs']`). The warning is stripped from production builds.

---

## [3.3.0] — 2026-06-11

A security-hardening, correctness, and performance release. No breaking changes.

### Security

- **Resource-hint URLs are sanitized** — `preloadModule`, `preloadResource`, and `prefetch` now run their `href` through the protocol allowlist and refuse dangerous schemes (`javascript:`/`data:`/`blob:`), consistent with the rest of the framework.
- **CSS-selector injection fixed in `preloadModule` (CWE-74)** — the dedup lookup interpolated the raw URL into a `querySelector` string; a URL containing `"`/`]` could throw or match the wrong element. The value is now escaped (matching the guard already used by the critical-resource preloader).
- **Testing-helper selectors hardened** — the query helpers in `testing/adapters` and `testing/a11y` escape interpolated values so labels/ids/roles with special characters can no longer break (or inject into) the selector.

### Fixed

- **`watch` / `store.subscribe` / `store.subscribeKey` callbacks run untracked** — signals read inside these callbacks are no longer recorded as dependencies, so a callback reading unrelated state can't cause spurious re-fires.
- **Reactive `srcset` uses per-candidate validation** — a reactively-bound `srcset` is now split and each candidate URL validated (matching the static path) instead of being passed through a single-URL sanitizer; the static and reactive write paths share one policy and can no longer drift.

### Performance

- **`sanitizeCSSValue` fast-path** — values containing none of the characters that gate a dangerous construct return immediately, skipping the decode + scan (~7× faster on common style values like `red`/`14px`/`#fff`). Affects every static and reactive style write.
- **`tagFactory` blocked-tag check precomputed** — the security blocklist is resolved once per tag factory instead of per element creation (~4× faster check, one fewer string allocation per element).
- **No per-notification closures** — `watch` and `store` subscriptions no longer allocate a closure on every notification.

### Removed

- Deleted empty deprecation stubs (`memo`, `memoFn`, and the `createSignal`/`createMemo`/`createEffect` pattern aliases) that had been no-ops since 1.4.0. Use `derived` / the canonical primitives directly.

---

## [3.2.2] — 2026-06-05

### Fixed
- 3.2.1 was published wrongly with the same changes than its previous version
- **Router — `Route`/`Outlet` outlet wedged after leaving a nested route** — navigating from a nested child route (e.g. `/ui/button`) to a top-level route could permanently freeze the `Route` outlet on the old layout, so every later navigation changed the URL but not the rendered page. The async `Route.update` state machine relied on an `isUpdating`/`pendingUpdate` pair plus a `route.path === currentPath` insert guard; under a startup/navigation timing race this could leave `isUpdating` stuck `true` (every later update short-circuited) and could insert stale route content. `Route` and `Outlet` now use a monotonic per-update sequence — a load that is superseded mid-flight is discarded, the latest navigation always commits ("latest wins"), and rapid bursts of navigations can no longer wedge the outlet.
- **Router — `Outlet` kept stale child content and leaked on navigation** — when the active route no longer matched a nested child, the `Outlet` returned early without removing its previous child; it also removed the old child without disposing it, leaking that subtree's reactive bindings and listeners on every nested navigation. The `Outlet` now clears (and disposes) stale content when leaving the nested area and skips redundant re-renders of the same child.

---

## [3.2.0] — 2026-06-01

A broad security-hardening and bug-fix release. No breaking changes.

### Security

- **`RouterLink` output is fully sanitized** — the resolved `href` now goes through the navigation protocol guard (blocking `javascript:`/`data:` click-to-XSS), and spread attributes are checked case-insensitively so `HREF`/`ONCLICK`/`xlink:href` can't bypass it. URL attributes are protocol-checked and inline `style` is CSS-sanitized.
- **Case-insensitive URL-attribute sanitization** — reactively-bound `HREF`/`SRC`/`xlink:HREF` are now recognized and sanitized (HTML attribute names are case-insensitive).
- **`stripHtml` uses a real parser** — replaced the naive regex (which left dangerous residue for nested/unclosed tags) with DOM-based text extraction, with a hardened fallback where no DOM exists.
- **SSR hardening** — `srcset` is sanitized as a candidate list (not a single URL); the `http-equiv="refresh"` guard is case-insensitive and now also applies on the router SSR document path.
- **Open-redirect** — navigation targets are normalized (control characters, backslashes, protocol-relative `//host`) before the safety check, closing bypasses of the cross-origin guard.
- **Prototype-pollution / inherited-key hardening** — `store`, `globalStore`, `createSlots`, the state-machine context merge, and `deepClone` now use own-key checks, preventing crashes (`store.constructor`) and pollution via `__proto__`.
- **Centralized security guards** — the prototype-pollution key filter, the `on*` event-handler check, and the URL control-character strip are now single shared, individually-tested helpers used by every call site (instead of being re-implemented, and occasionally diverging, across `store`/`router`/`SSR`/template paths), so the same hole can't reappear in one path while another stays fixed.

### Fixed

- **htm template parser** — unquoted attribute values containing `/` are preserved (e.g. `href=http://x/y` no longer truncates to `http:`); a bare `<` in text (`a < b`, `I <3`) renders as text instead of crashing; HTML comments / CDATA / doctype / processing instructions are skipped; multi-root templates keep every sibling node.
- **Reactive children (`bindChildNode`)** — node order is preserved across re-renders (multi-node children no longer reverse), and removed nodes are disposed (no leak on `() => cond ? X : null` toggles).
- **Disposal correctness** — a disposed `effect` or reactive DOM binding can no longer run or re-subscribe if it was already queued when disposed ("dispose" reliably means "stop").
- **Reactivity** — `derived` applies a custom `equals` even when the previous value is `undefined`; `deepEqual` distinguishes objects with different key sets and `DataView` contents.
- **Router** — fixed param interpolation when one param name is a prefix of another, base-path stripping at non-segment boundaries, incomplete `removeRoute` (children/aliases/named entries), malformed `%`-escape decoding, the `KeepAlive` cache key (query/hash), and component-loader cache cardinality (keyed by route definition, not resolved URL).
- **Scheduler** — fixed a priority inversion (a `USER_BLOCKING` task no longer waits behind a pending frame) and the `processInChunks` chunk boundary.
- **Animations / transitions** — an interrupted `enter()`/`leave()` promise now settles instead of hanging forever.
- **Devtools / build** — `formatError` guards cyclic `cause` chains; `compileTemplates` no longer drops sibling root nodes; the `no-signals-in-conditionals` lint rule no longer false-positives after a closed nested callback.
- **Data** — `offlineStore` coalesces pending changes per key and fixes a broken `_meta` IndexedDB write; `infiniteQuery` dedups concurrent page fetches and fixes window-edge page-param recomputation.
- **Memory leaks** — directives (`when`/`match`/`show`), `aria`, `VirtualList`, the chunk loader, `Suspense`'s in-flight child, the route-loader abort listener, and the MobX adapter bridges now release their subscriptions/listeners on teardown; `debounce`/`throttle`/`previous` expose a `dispose()` handle; devtools perf samples and the router error cache are bounded.

### Added

- **Request-scoped query cache under SSR** — `query()` no longer shares cached data between concurrent server renders (backed by `AsyncLocalStorage`).
- **`infiniteQuery` `maxPages`** — optional sliding-window cap on retained pages.
- **`mutation` cancellation** — `reset()` (and a superseding `mutate()`) aborts the in-flight retry chain; the mutation function now receives an `AbortSignal`.

---

## [3.1.0] — 2026-05-29

### Fixed

- **Per-run dependency tracking for DOM bindings** — a reactive child (`() => value`), a reactive `class`/`style` getter, and `watch` now re-track their dependencies on **every** run, matching `derived` and `effect`. Previously these bindings subscribed only to the signals read on their *first* evaluation: a signal first read on a later run (e.g. a conditional branch that becomes live after a state change) was never subscribed, so updates to it did not re-render. Signals no longer read on the latest run are also pruned (no over-subscription). The fix is centralized in `track()` — any eagerly-re-running binding registered without an explicit subscriber now uses a self-re-tracking subscriber.

  ```ts
  const [total, setTotal] = signal(0);
  const [bytes, setBytes] = signal(0);
  const el = div(() => (total() ? `${bytes()} / ${total()}` : "waiting"));
  mount(() => el, root);
  setTotal(100); // re-runs; bytes() first read here
  setBytes(42);  // now "42 / 100" — previously stayed "0 / 100"
  ```

  This also fixes `query()` data not reaching a status-branching consumer (`if (q.loading()) …; return List(q.data())`) where `data()` was only read once not loading.

### Added

- **Dev warning for a misplaced lone class string** — `tag("space-y-6")` still renders the string as a text child (unchanged), but development builds now warn when a lone string looks like a CSS class list, hinting `tag({ class: "…" })` or `tag("…", children)`. Prose strings never trigger the warning.

---

## [3.0.0] — 2026-04-19

### Breaking

- **`ErrorBoundary` drops the `nodes` option** — the subtree is now passed as the positional second argument, matching the tag-factory shorthand (`tag(props, children)`). This removes the last `nodes:` prop from the public framework surface (tag factories migrated in 1.3.0). Signature:

  ```ts
  ErrorBoundary(children: () => Element): Element;
  ErrorBoundary(options: ErrorBoundaryOptions, children: () => Element): Element;
  ```

  **Migration:**

  ```ts
  // Before
  ErrorBoundary({
    nodes: () => RiskyArea(),
    fallback: (err, retry) => …,
    onError,
    resetKeys,
  });

  // After
  ErrorBoundary(
    { fallback: (err, retry) => …, onError, resetKeys },
    () => RiskyArea(),
  );

  // Options-free form
  ErrorBoundary(() => RiskyArea());
  ```

  `ErrorBoundaryProps` is retained as a deprecated alias of the renamed `ErrorBoundaryOptions` so type imports keep compiling.

---

## [2.2.0] — 2026-04-18

Reactivity-core rewrite. Replaces the `Set<Subscriber>` / `Map<Signal, epoch>` subscription graph with doubly-linked `SubNode` edges, a node pool, and an `__activeNode` back-pointer for O(1) duplicate-dependency detection. Subscription is now O(1) on both add and remove, the hot path has no hash operations, and GC churn on create/destroy workloads drops sharply.

**Improvements over 2.1.0 on the reactivity stress-test suite (`benchmarks/`):**

- **Wide graph / 10k fan-out: ~73% faster** (56.8 ms → 15.4 ms)
- **Cascading effects: ~41% faster** (2.03 ms → 1.20 ms)
- **Memory & cleanup: ~21% faster** (51.3 ms → 40.6 ms)
- **Component tree propagation: ~10% faster** (23.0 ms → 20.6 ms)
- **Deep computed chain: ~7% faster** (3.87 ms → 3.60 ms)

**201/201 test files, 2187/2187 tests passing. No breaking changes to the documented public API** — `signal`, `derived`, `effect`, `batch`, `untracked`, `on`, `setMaxDrainIterations`, `setMaxSubscriberRepeats`, devtools introspection helpers, all behave identically.

### Added

- **`cleanup(subscriber)`** now exported from `sibujs/reactivity/track`. Disposes a subscriber directly without allocating an intermediate closure. Enables custom effect-like primitives to manage their own lifecycle without going through `track()`'s disposer.
- **`getSubscriberCount(signal)`** — O(1) count of active subscribers, read from the `__sc` counter maintained on every subscribe/unsubscribe.
- **`getSubscriberDeps(subscriber)`** — returns the signals a subscriber currently depends on, in record order. Replaces the previous `_dep` / `_deps` probe used by devtools.
- **`forEachSubscriber(signal, visit)`** — iterate a signal's subscriber list without exposing the internal linked-list structure to callers.

### Changed

- **Subscription storage migrated from Set + Map to doubly-linked `SubNode` edges.** Each `(signal, subscriber)` pair is one object linked into both the signal's subscriber list and the subscriber's dep list. O(1) subscribe / unsubscribe via pointer splice, no hash operations on the hot path, one allocation per edge instead of two.
- **Duplicate-dependency detection during tracking is now O(1)** via a `signal.__activeNode` back-pointer (Preact Signals' approach). A subscriber with 10 000 deps reading one signal twice no longer pays O(N²) in its inner loop.
- **Effects now re-run via `retrack()` instead of `track()`.** Stable-dep effects (the overwhelmingly common case) skip the cleanup-and-rebuild cycle entirely — epoch-based pruning at end of run handles any deps that were dropped this invocation. On the Cascading Effects benchmark this drops per-invocation cost by ~40 ns.
- **Effect internals consolidated behind an `EffectCtx` object.** Per-effect closure count went from six (`onCleanup`, `flushUserCleanups`, `wrappedFn`, `drainReruns`, `subscriber`, `dispose`) to three. `runSubscriber` and `runBody` are inlined directly into the per-effect closures, eliminating a function frame per invocation.
- **`track()` is stack-free.** The shared `subscriberStack` array is gone; `track()` uses a local `prev` / restore pattern, and `suspend/resumeTracking` capture `currentSubscriber` directly. ~5–10 ns saved per track call, universal improvement.
- **Signal state pre-initialises every internal slot** (`__v`, `__sc`, `subsHead`, `subsTail`, `__activeNode`, `__name`) at construction. V8 hidden classes stay monomorphic across all signals; inline caches in the reactivity hot paths don't transition on first subscribe.
- **Signal setter specialised at creation time** — one closure for the default `Object.is` equality path, one for custom `equals`, one dev-mode variant carrying the devtools-hook emission. No per-call branching on the hot path.
- **Cached `track()` disposer** via `sub._dispose ??= …` — allocated once per subscriber instead of once per `track()` call. Meaningful for high-churn workloads (large lists, create/destroy cycles).
- **Node pool** (cap 4 096) recycles freed `SubNode` objects. Shape-stable allocation keeps hidden classes monomorphic; a create/destroy cycle with 25 000 effects reuses edge nodes instead of allocating and freeing them.

### Removed

- **`signal.__s`** — the Set-based subscriber cache. Replaced by `subsHead` / `subsTail` linked-list anchors plus `__sc` (count). External consumers should read counts via `getSubscriberCount()`.
- **`signal.__f`** — the single-subscriber fast-path cache. A one-node linked-list walk is inherently as fast as the check it was avoiding.
- **Internal `subscriberStack`** — the shared push/pop array used by the old `track()` / `suspend/resume` pair. Not observable from user code.

### Internal

- `introspect.ts` delegates to the new `getSubscriberCount` / `getSubscriberDeps` / `forEachSubscriber` helpers. Public API surface (`ReactiveNodeInfo`, `getSignalName`, `getDependencies`, `inspectSignal`, `walkDependencyGraph`) unchanged.
- `devtools.ts` reads `node.ref?.__sc` instead of `node.ref?.__s.size`.
- A three-color CLEAN/CHECK/DIRTY propagation model was prototyped and reverted after benchmark regression (+122% on Deep Chain). The workloads in the current suite all produce new downstream values on every signal change, so the CHECK state has no work to skip — only overhead to add. A dedicated benchmark suite for stabilisation patterns needs to come first; re-introducing three-color propagation is parked for a future release.

---

## [2.1.0] — 2026-04-17

Reactivity-core hardening release. Closes correctness gaps around effect re-entry, derived stale deps, sibling-effect consistency, and cycle detection. **201/201 test files, 2187/2187 tests passing — no behavior changes to user code that was already correct.**

### Fixed

- **Effects that write to a signal they subscribe to no longer silently drop the update.** Previously the re-entrant invocation was dropped with a dev-only warning, leaving the effect's observed state out of sync with reality. Now the update is flagged as `rerunPending` and the effect re-runs after its current body completes, converging on consistent state. A 100-iteration safety cap breaks legitimate write-reads-self cycles with a loud `console.error` instead of hanging.
- **`derived()` no longer accumulates stale dependencies on conditional code paths.** A getter like `() => flag() ? a() : b()` used to keep both `a` and `b` subscribed forever once both had been read, causing spurious re-evaluations whenever the untaken branch fired. The `retrack()` pull path now tags each dependency with a per-evaluation epoch and unsubscribes any edge whose epoch is stale at end of run — bounded memory, no spurious work.
- **Sibling effects now converge to consistent state through the outermost notification.** Previously two paths of `notifySubscribers` diverged: the pure-effect fast path allowed re-enqueue (effects could run twice, final state consistent), while the mixed-computed slow path forbade it (effects ran once, possibly observing stale downstream state). Both paths now share a single drain with at-most-once enqueue dedup cleared before invoke — sibling effects that cross-write converge rather than one losing to the other.
- **Unbounded empty-`__s` allocation per signal.** Signals whose last subscriber disposed kept an empty subscriber `Set` on the signal object for the process lifetime. The set is now cleared when size drops to zero.
- **`subscriberStack` never released memory after a one-off nesting spike.** A transient deep-nesting excursion (e.g. a debug-mode traversal) could double the stack and retain it forever. The stack now shrinks lazily at end-of-`track()` when idle and over-allocated.

### Changed

- **Cycle detection is now per-subscriber repeat-counted instead of total-iteration-capped.** The previous 100 000-iteration cap conflated "infinite cycle" with "legitimate large fan-out" — apps with 100k+ effects in one batch flirted with false positives while real tight cycles could burn the full budget before tripping. The new detector counts per-subscriber firings within a drain and bails when any single subscriber exceeds `maxSubscriberRepeats` (default 50) — accurate, cheap, and tolerant of arbitrary legitimate fan-out. The absolute iteration cap is retained as a safety net at 1 000 000.
- **`setMaxDrainIterations(n)`** is now the safety-net knob rather than the primary cycle check; semantics unchanged for callers, default raised from 100 000 → 1 000 000.

### Added

- **`setMaxSubscriberRepeats(n)`** — raise/lower the per-subscriber repeat cap used for cycle detection. Returns the previous value.

### Internal

- Subscriber dep storage in the reactivity core migrated from `Set<signal>` to `Map<signal, epoch>` to carry per-edge epoch tags for `retrack()` pruning. Public API unchanged; the single-dep fast path still avoids `Map` allocation entirely.
- `__f` / `__s` fast-path invariant centralized in a `syncFastPath()` helper — same performance, simpler to reason about across add/remove sites.
- Devtools `introspect.getDependencies()` updated for the new `Map` layout; return type unchanged.

---

## [2.0.0] — 2026-04-14

Major hardening + features release. Spans reactivity, rendering, SSR, widgets, security, and build tooling. **2187/2187 tests passing, zero lint errors, zero type errors.**

### Breaking

- **Adapter method renames** — `redux.useSelector` → `redux.select`, `zustand.useSelector` → `zustand.select`. The `use*` prefix is no longer used anywhere in the framework.

  ```ts
  // before
  const count = redux.useSelector(s => s.count);
  // after
  const count = redux.select(s => s.count);
  ```
- **`useDefaultPluginRegistry` renamed to `setDefaultPluginRegistry`** — aligns with the verb-based convention used elsewhere.
- **`loadRemoteModule()` now refuses un-allowlisted URLs** — previously warned in dev and loaded anyway. Now rejects unless `{ allowedOrigins: [...] }` or `{ unsafelyAllowAnyOrigin: true }` is passed (CWE-829 supply-chain hardening).
- **`loadWasmModule()` / `preloadWasm()` require origin allowlist** — same policy as `loadRemoteModule`. Options bag now disambiguated via `allowedOrigins`/`unsafelyAllowAnyOrigin` keys only.
- **`compiled.staticTemplate()` / `precompile()` require `TrustedHTML`** — arbitrary strings no longer accepted to prevent silent `innerHTML` XSS sinks. Mint via `trustHTML(raw)` after your own sanitization pass.
- **Router refuses protocol-relative redirects** — `"//evil.com/path"` style redirect targets now throw `NavigationFailureError` instead of logging a warning (CWE-601 open redirect).
- **`hydrate()` / `hydrateIslands` / `hydrateProgressively` use replace strategy** — the prior in-place attribute-reconciliation silently orphaned reactive bindings to the discarded client tree, leaving the visible DOM frozen. The client subtree now replaces the server subtree (island markers and `data-sibu-hydrated` preserved) so reactive bindings actually drive the DOM.
- **`socket()` / `stream()` default `maxReconnects` is now 10** — was effectively unbounded. Permanently broken URLs no longer hammer servers forever. Exponential backoff with jitter added.
- **`optimisticList()` deprecated aliases removed** — `addOptimistic`/`removeOptimistic`/`updateOptimistic` were deprecated in 1.5.0 and are now gone. Use `add`/`remove`/`update`.
- **`contentEditable().setContent` signature widened** — takes either a string (raw HTML, legacy) or `{ text, html, sanitize }`. The options form is the recommended path.

### Added

- **`retrack()`** reactivity primitive for derived pull-path — skips the `track()` cleanup pass; uses save/restore of `currentSubscriber` instead of stackTop push/pop. Steady-state chains avoid Set.delete+add churn.
- **`effect((onCleanup) => { … })`** — canonical teardown pattern now built in. User cleanups run in reverse registration order before every re-run and on dispose; throwing cleanups are isolated and logged.

  ```ts
  effect((onCleanup) => {
    const handler = () => { … };
    window.addEventListener("resize", handler);
    onCleanup(() => window.removeEventListener("resize", handler));
  });
  ```
- **`derived(getter, { equals })`** — custom equality suppresses notifications when the recomputed value is equivalent to the previous.
- **`Dispose` canonical type** exported from `sibu`.
- **Widget ARIA `bind()` layer** — every headless widget now ships a `bind(els)` that wires roles, keyboard, and idempotent teardown per WAI-ARIA APG:

  - `Tabs` — role=tablist, roving tabindex, Arrow/Home/End
  - `Accordion` — aria-expanded/controls, Enter/Space
  - `Tooltip` — role=tooltip, aria-describedby splice, Escape dismiss, hoverable grace
  - `Popover` — role=dialog, aria-haspopup, Escape + click-outside
  - `Combobox` — Combobox 1.2 pattern, aria-activedescendant, typeahead
  - `Select` — role=listbox, aria-multiselectable, typeahead, disabled-aware
  - `FileUpload` — labeling, aria-describedby splice, drop-zone keyboard
  - `datePicker` — role=grid, arrow/Home/End, PageUp/Down, Shift+PageUp/Down (year)
  - All `bind()` returns are idempotent via WeakMap and restore every touched attribute on dispose.
- **`takePendingError()` exported** — ErrorBoundary now scans mounted subtrees for stashed errors from `lazy()` rejections that beat any boundary to mount. Multiple pending errors wrapped in `AggregateError`.
- **`trustHTML(html)` + `TrustedHTML` type** re-exported from `sibu` (was only on `sibu/ssr` and `sibu/performance`, which minted incompatible brands).
- **Test-reset helpers** — `__resetQueryCache`, `__resetDialogStack`, `__removeRouterPagehideHandler`.
- **Build/release hardening** — `tsup --clean`; `./cdn` subpath export; `publishConfig.access=public` + `provenance=true`; `publish.mjs` publishes BEFORE git commit/tag (so a publish failure leaves no orphan commit).
- **10 new tests** — `keepAlive.test.ts`, `pluginRegistry.test.ts`, `widgetsAria.test.ts`.

### Fixed — Reactivity

- **`derived` pull-path correctness under `suspendTracking`** — new conditional deps register their markDirty subscription even when the outer caller is in `untracked()` context.
- **`propagateDirty`** is iterative (no recursion) with already-dirty skip — closes O(depth²) walk on deep chains.
- **`batch.flushBatch`** wrapped in try/finally — a throwing subscriber can't strand `pendingSignals` for the next batch.
- **`effect()` disposer idempotent** — double-dispose no longer re-emits `effect:destroy` or re-walks subs lists.
- **`effect()` re-entry detection** — a re-entering update now warns in dev and drops (was silent).
- **`bindChildNode` diff** — O(n²) nested scan replaced with O(n+m) Set-based reuse detection; dedupes duplicate node refs in the output array.
- **Dead `signalSubscribers` WeakMap** removed (the `__s` property cache is authoritative).

### Fixed — Rendering & Lifecycle

- **`dispose()` re-entry safe** — snapshot-then-delete + bounded extra-pass drain. `Array.from(childNodes)` snapshot guards against disposers mutating the tree mid-walk.
- **`onUnmount` false-fires on same-tick re-parent** — `fireUnmount` defers one microtask and re-checks `isConnected`.
- **`lifecycle` descendant walk** short-circuited for leaf insertions.
- **`keepAlive` disposed-flag** prevents post-dispose microtask writes; cached subtrees properly disposed on anchor teardown.
- **`each` itemGetter** wraps in `untracked()` so per-row consumers don't subscribe to the whole-array signal.
- **`each`, `portal`, `lazy.Suspense` error propagation** — CustomEvent dispatched on the anchor's Element parent (Comment anchors don't bubble); deferred one microtask for pre-mount races.
- **`lazy()` pending-error stash** (`PENDING_ERROR` marker) — ErrorBoundary scans descendants on mount so failures before any boundary mounts aren't silently lost.
- **`hydrateProgressively` island marker preserved** on replacement.

### Fixed — Data & Platform

- **`workerFn` pool crosstalk** — per-worker FIFO queue with `addEventListener`; terminate-on-error so concurrent `run()` calls can't mis-route results.
- **`worker()` top-level** uses `addEventListener` + terminate-on-error.
- **`infiniteQuery` run-id generation** — stale responses discarded; `AbortController.abort()` at top of effect.
- **`offlineStore` atomic writes** — `idbPutWithChange` / `idbDeleteWithChange` single-transaction across `items`+`_changes`; cursor-snapshotted sync; pull skips items with pending local edits (conflict avoidance); `idbPutMany` batches remote items; `closed` flag checked between awaits; `sync()` error now logs via `devWarn` (was silent).
- **`query` dedup** captures `entry.promise` locally and re-checks identity after await; sync-throw from `withRetry` cleaned up; `onSettled` in `finally`; `dispose()` idempotent + gcTimer deduplicated.
- **`chunkLoader`** true LRU with `lastAccess`; `invalidate(id)` clears `preloaded`; `this.load` replaced with closure reference (destructure-safe); preload `.delete(id)` on failure.
- **`serviceWorker`** listener refs tracked; prior `statechange` detached before reassignment; all detached in `unregister()`.
- **`incrementalRegeneration`, `routerSSR`, `wakeLock`, `clearQueryCache` refetchers** — `.catch` instead of silent.
- **`mutation.mutate()`** fire-and-forget rejection now warns (was silent `catch(() => {})`).

### Fixed — SSR

- **`runInSSRContext`** uses Node's `AsyncLocalStorage` when available so concurrent requests don't share `ssrMode`/suspense counters.
- **`serializeState`** byte cap via `TextEncoder`; escapes U+2028/9; drops the `__SIBU_SSR_STATE_RAW__` fallback (defeated escape).
- **`deserializeState`** dev-warns when no `validate` guard is passed.

### Fixed — Widgets & UI

- **`datePicker` month/year overflow** — uses day-1 anchor (no Jan-31→Mar-3 drift).
- **`form.wrappedSet`** clears `manualErrors` on edit (server-side "email taken" errors no longer stick after user edits).
- **`Tooltip.bind()` teardown** splices its id out of the current `aria-describedby` so ids added by other libraries survive.
- **`a11y.FocusTrap`** `keydown` removed on dispose; announce live region checks `isConnected` before writing.
- **`inputMask.bind()`** returns a dispose function that removes input/focus listeners.
- **`customElement._teardown`** runs `dispose()` on rendered subtree before reconnect (reactive bindings no longer leak across reconnects).

### Fixed — Plugins & Router

- **`router.cleanupNodes`** calls `dispose(node)` before detaching — every reactive binding inside a route subtree is torn down on navigation.
- **`Route()` / `KeepAliveRoute()` / `Outlet()`** `track()` teardowns stored in `routeCleanups` (was leaking effects).
- **`RouterLink` click listener** removed via `registerDisposer`; navigate failures `.catch`'d.
- **Router `pagehide` listener lazy-initialized** on first `createRouter()` call (honors `sideEffects: false`).

### Fixed — Security

- **`URL_ATTRIBUTES`** expanded: `xlink:href`, `formtarget`, `ping`, `data` now run through `sanitizeUrl()` (was bypassed).
- **`persist` + `dragDrop` `JSON.parse`** revivers block `__proto__`/`constructor`/`prototype` (CWE-1321).
- **`each` error dispatch** logs via `devWarn` when anchor is detached (no silent swallow).

### Fixed — Performance

- **Spring animation** is `dt`-aware (`REF_DT_MS`, `MAX_STEP_RATIO=4`, NaN-guard) — frame-rate-independent; no runaway on tab-throttle.
- **`speech.ts` setInterval** polls only while actively speaking (was constant 5Hz).
- **`socket` / `stream` auto-reconnect** — exponential backoff with jitter.

### Fixed — DX

- **Error prefix standardized to `[SibuJS]`** (was mix of `[Sibu]` / `[Sibu strict]` / `[Sibu hydration]`).
- **`devtools.hmr`** calls `disposeNode` on replaced subtrees so HMR reloads don't leak effects/listeners.
- **`testing.unmount` / `unmountAll`** call `dispose()` before clearing DOM (was `innerHTML = ""`, leaked every effect/binding).
- **`tsconfig.json`** drops `"types": ["vitest"]` — zero `src/` deps on test-only types.
- **Unused `biome-ignore` suppressions** removed; unused variables cleaned.

### Migration

Most apps need no changes. If you hit any of these:

- **`redux.useSelector` / `zustand.useSelector`** → rename to `select`.
- **`useDefaultPluginRegistry`** → rename to `setDefaultPluginRegistry`.
- **`loadRemoteModule(url)` without options** → pass `{ allowedOrigins: [...] }` (recommended) or `{ unsafelyAllowAnyOrigin: true }` for opt-in.
- **`loadWasmModule(url)`** → same.
- **`compiled.staticTemplate(html)`** → wrap via `trustHTML(html)` after your sanitization.
- **`hydrate()` consumers relying on preserved server DOM refs** → client tree replaces server tree; grab refs after mount.
- **`socket({ autoReconnect: true })`** → now caps at 10 reconnect attempts; pass `maxReconnects: Infinity` to restore prior behavior.
- **Router redirects to `//other-host/path`** → now throw; rewrite as relative or absolute `https://` within an allowed origin.
- **`optimisticList().addOptimistic/removeOptimistic/updateOptimistic`** → rename to `add`/`remove`/`update`.

---

## [1.5.0] — 2026-04-11

Comprehensive bug-fix and hardening release. **30 bugs fixed across 29 files**, covering the reactive core, data fetching, state management, routing, rendering, lifecycle, forms, UI utilities, browser composables, and devtools. Full framework audit with 2178/2178 tests passing, zero regressions.

### Breaking

- **`optimistic()` return shape changed** — previously returned a `[getter, setter]` tuple; now returns a named object `{ value, pending, update }`. The `pending` signal was created internally but never exposed (Bug: users had no way to show loading indicators). The `update` method now uses a version counter to prevent stale reverts from concurrent operations. Migration:

  ```ts
  // before
  const [value, addOptimistic] = optimistic(0);

  // after
  const { value, pending, update } = optimistic(0);
  ```
- **`optimisticList()` method names shortened** — `addOptimistic` → `add`, `removeOptimistic` → `remove`, `updateOptimistic` → `update`. The old names are kept as deprecated aliases so existing code keeps working.

### Fixed — Core Reactivity

- **`deepEqual` shared-reference false positive** — the `seen` set tracked only `a`, not `(a, b)` pairs. Shared sub-objects compared against different partners were incorrectly treated as equal. Now tracks `Map<object, Set<object>>` pairs.
- **`deepEqual` constructor mismatch** — `deepEqual(new Date(), {})` returned `true` because Date has no enumerable keys. Added constructor guard before falling through to key comparison.
- **`deepEqual` Map/Set not compared** — `Map` and `Set` contents were invisible to `Object.keys`. Added explicit Map (deep value equality) and Set (shallow membership) branches, plus ArrayBuffer and TypedArray support.
- **`deepEqual` self-referential Map/Set** — cycle detection was placed after the Map/Set branches, causing infinite recursion on self-referential containers. Moved cycle detection before all container comparisons.
- **`derived` circular dependency** — circular derived chains caused silent stack overflow. Added an `evaluating` re-entrance flag that throws a clear `"Circular dependency detected"` error with the signal's debug name.
- **`drainNotificationQueue` infinite loop** — an effect writing to a signal it reads could loop forever. Added a `MAX_DRAIN_ITERATIONS = 1000` cap with a console error diagnostic.
- **`deferredValue` never updated** — had no reactive subscription on the source getter (no `effect`/`track`). Rewrote to use `effect()` for source tracking, scheduling LOW-priority updates via the scheduler.

### Fixed — Data Fetching

- **`resource.abort()` left `loading()` stuck at `true`** — the `AbortError` catch returned without resetting the loading signal. Now calls `setLoading(false)` in the abort path.
- **`query` subscriber leak on same-key re-run** — effect re-runs with an unchanged key double-counted `entry.subscribers`, preventing cache GC. Now only increments when the key actually changed or the entry has zero subscribers.
- **`mutation` concurrent state clobbering** — rapid `mutate()` calls raced without guard. Added a `runId` version counter; stale responses are silently ignored.
- **`withRetry` abort listener leak** — the `abort` event listener on `AbortSignal` was never removed when the delay timer resolved normally. Added `removeEventListener` in the timer resolve path.

### Fixed — State Patterns

- **`optimistic` concurrent stale reverts** — each operation now gets a version number; reverts only fire if no newer operation has started. Prevents stale snapshots from overwriting fresher optimistic state.
- **`optimistic` `pending` never exposed** — the `pending` signal was created but never returned. Now exposed in the return object for both `optimistic` and `optimisticList`.
- **`optimisticList.updateOptimistic` predicate failure after patch** — the success-path predicate re-ran against the already-mutated item. If the patch changed the matched property, the server result was silently dropped. Now captures patched references during the optimistic phase and matches by identity in the success path.
- **`persisted` effect not stopped by `dispose()`** — the persisting effect's return value was discarded, so `dispose()` only removed the storage listener but left the effect running. Now captured and called in `dispose()`.
- **`globalStore` shallow initial copy** — `reset()` could fail to fully restore nested objects if they were mutated in-place. Changed to `JSON.parse(JSON.stringify(...))` for a deep copy of initial state.

### Fixed — Routing

- **Wildcard route too permissive** — `/admin/*` incorrectly matched `/admin-panel` because the check used `path.startsWith(basePath)` without a segment boundary. Now requires `path === basePath || path.startsWith(basePath + "/")`.
- **Guard timeout/abort listener leak** — when `next()` was called asynchronously, the microtask-based cleanup had already run and missed it. Moved `clearTimeout` + `removeEventListener` into the `next()` callback itself. The abort handler now also clears the timeout timer.

### Fixed — Rendering & Lifecycle

- **`dispose()` one throwing disposer aborted entire subtree cleanup** — wrapped each disposer call in try/catch with a dev-mode warning.
- **`onMount` cleanup return discarded** — the type signature accepted a cleanup return function but `safeCall` discarded it. Now captured and registered via `registerDisposer(element, cleanup)`.
- **`onMount` MutationObserver leaked** — if an element was disposed before ever connecting to the DOM, the observer on `document.body` ran forever. Now registered for cleanup via `registerDisposer`.
- **`onUnmount` observer ran for element's entire lifetime** — the MutationObserver on `document.body` fired on every DOM mutation globally. Now registered for cleanup via `registerDisposer` and the callback itself is also wired through `registerDisposer` as the primary teardown path.
- **`Portal` cleanup via MutationObserver only** — didn't integrate with `dispose()`/`when()`/`match()`/`each()`. Replaced with `registerDisposer(anchor, ...)` so portal content is properly disposed and removed through the standard dispose system.
- **`lazy` stale load** — if the container was removed before the dynamic import resolved, the rendered component leaked subscriptions. Added a `disposed` guard that silently drops stale `.then()`/`.catch()` callbacks. Removed dead `_status`/`_error` signals that were created but never read.

### Fixed — UI Utilities

- **`bindField` merge order** — `{...fieldOn, ...extraOn}` let extras clobber field handlers (input/change/blur). Contradicted the 1.0.4 fix intent. Flipped to `{...extraOn, ...fieldOn}` so field handlers always win.
- **`form.handleSubmit` double-submit** — no guard against concurrent async submissions. Added a `submitting` signal; `handleSubmit` checks it before calling the callback and resets on resolve/reject. Exposed as `form.submitting()` on `FormReturn`.
- **`inputMask` cursor jump** — no cursor position restoration after mask application; cursor jumped to end on every keystroke. Added cursor tracking that counts raw chars before the old cursor position and places the cursor after that many filled slots in the masked output.
- **`inputMask` strip regex too aggressive** — `/[^a-zA-Z0-9]/g` stripped all special characters, making `*` mask slots unable to accept non-alphanumeric input. Now builds a pattern-aware strip regex: patterns with `*` only strip literal mask characters.
- **`transition` rapid enter/leave** — stale `setTimeout` callbacks from a previous enter/leave fired during the opposite animation, corrupting class state. Added `activeTimer` tracking with `cancelPending()` at the start of each enter/leave.
- **`scopedStyle` pseudo-element scoping** — scope attribute was appended after `::before`/`::after` pseudo-elements, producing invalid CSS selectors. Now splits at `::` and inserts `[attr]` before the pseudo-element.
- **`VirtualList` scroll listener leak** — the scroll event listener was never cleaned up. Added `registerDisposer` with `removeEventListener`.
- **`dialog` no dispose** — the global keydown listener leaked if the dialog was open when the component was destroyed. Added `dispose()` method that detaches the listener and resets state.
- **`FocusTrap` observer scope** — MutationObserver watched only the direct parent; ancestor removal leaked the observer and missed focus restore. Changed to `document.body` with `subtree: true`. Added `registerDisposer` integration for SPA cleanup. Zero-focusable-elements case now calls `e.preventDefault()` to prevent Tab from escaping the trap.

### Fixed — Browser Composables

- **`urlState` missing `hashchange` listener** — anchor clicks and `location.hash` assignments don't fire `popstate`, so `hash()` went stale. Added `hashchange` listener alongside `popstate`. Added deduplication guard to avoid unnecessary signal notifications. `setHash("#")` now clears the hash instead of keeping a bare `#`.
- **`scroll` non-reactive target** — the scroll target element was resolved once at creation and never re-evaluated. Rewrote to use `effect()` for reactive target tracking, re-attaching the listener when the element changes (same pattern as `resize`/`dragDrop`).
- **`socket.close()` auto-reconnected** — the `onclose` handler couldn't distinguish manual close from unexpected disconnect. Added a `manuallyClosed` flag set in `close()` and checked in `onclose` to suppress auto-reconnect.

### Fixed — DevTools

- **`createTraceProfiler` subscribed to non-existent events** — listened for `effect:start`/`effect:end`/`signal:set` but the core emits `effect:create`/`effect:destroy`/`signal:update`. Fixed event names and changed to instant (`"I"`) events since the core doesn't emit begin/end pairs.

### Changed

- **`optimistic()` returns a named object** — `{ value, pending, update }` instead of `[getter, setter]`. See Breaking section.
- **`optimisticList()` shorter method names** — `add`/`remove`/`update` with deprecated `addOptimistic`/`removeOptimistic`/`updateOptimistic` aliases.
- **`deepSignal` return type** — now infers from `signal()` directly, preserving the `Accessor<T>` brand on the getter.
- **`hotkey` `global` option removed** — was declared but never used (dead code).
- **`context` JSDoc updated** — accurately describes global reactive store semantics instead of falsely promising subtree-scoped DI.
- **JSDoc examples across 17 source files** — ~35 code examples converted from legacy `{ nodes: }` form to canonical positional shorthand.
- **README** — updated to canonical shorthand authoring style; `$(pattern matching)$` typo fixed.

### Tests

- **`deepSignal.test.ts`** — expanded from 4 → 52 tests covering Map, Set, TypedArray, shared refs, cycles, constructor mismatch.
- **`urlState.test.ts`** — expanded from 6 → 20 tests covering hashchange, dedup, edge cases, SSR.
- **`optimistic.test.ts`** — expanded from 5 → 17 tests covering pending, concurrent guards, predicate-after-mutation.
- Full suite: **2178 / 2178 passing** (up from 2105 in 1.4.0). Zero regressions.

---

## [1.4.0] — 2026-04-11

Cleanup release. Removes six public aliases that contradicted the SibuJS philosophy — plain verbs, no framework ceremony, no redundant synonyms for the same primitive. All of the removed APIs were either one-line forwards to an existing primitive or identity wrappers; every existing example can be rewritten by deleting the wrapper and calling the underlying primitive directly.

### Removed

- **`createSignal`** — was `return signal(value)`. Use `signal()` directly.
- **`createMemo`** — was `return derived(fn)`. Use `derived()` directly.
- **`createEffect`** — was `return effect(fn)`. Use `effect()` directly.
- **`memo`** — was `return derived(factory)`. Use `derived()` directly.
- **`memoFn`** — was `return derived(callback)`. Use `derived()` directly.
- **`composable`** — was `return setup` (identity function). Plain functions are already composables in SibuJS; just write one and call it.

The three removed files (`src/patterns/primitives.ts`, `src/core/signals/memo.ts`, `src/core/signals/memoFn.ts`) are currently empty stubs exporting nothing — they can be deleted from disk in a follow-up commit without further code changes.

### Migration

```ts
// before
import { createSignal, createMemo, createEffect, memo, memoFn, composable } from "sibujs";

const [count, setCount] = createSignal(0);
const doubled = createMemo(() => count() * 2);
const sorted = memo(() => items().slice().sort());
const handler = memoFn(() => (e: Event) => process(e));
createEffect(() => console.log(count()));
const useCounter = composable(() => { /* … */ });

// after
import { signal, derived, effect } from "sibujs";

const [count, setCount] = signal(0);
const doubled = derived(() => count() * 2);
const sorted = derived(() => items().slice().sort());
const handler = derived(() => (e: Event) => process(e));
effect(() => console.log(count()));
function useCounter() { /* … */ }
```

### Also updated

- `generateComponentMetadata`, `generateTypeStubs`, and the Vite/Webpack pure-annotation factory list in `sibujs/build` no longer mention the removed names.
- Lint rule `no-signals-in-conditionals` no longer checks `memo` / `memoFn` (they don't exist).
- `SignalNodeSnapshot.kind` comment updated to drop the `"memo"` tag.
- Test suite: `tests/primitives.test.ts`, `tests/memo.test.ts`, `tests/memoFn.test.ts` reduced to placeholder stubs; `tests/types.test.ts` and `tests/ide.test.ts` updated to assert the aliases are gone. Suite: **2105/2105 passing** (down from 2113 by exactly the 8 deleted alias-specific tests).

---

## [1.3.0] — 2026-04-11

Large minor release. Adds **27 new reactive/DOM primitives**, a full **SSR + OWASP security hardening pass** (A01, A02, A03, A10 + CWE-1321 prototype pollution), **10 ergonomic features** that stay inside the SibuJS philosophy (No VDOM, No JSX, No compilation, Zero dependencies, fine-grained reactivity), **typed tag factory overloads** for common elements, and a new **`tag(props, children)` positional shorthand** that removes the need for the `nodes:` key at every level of the tree. Test suite grew from **1875 → 2113** passing tests (+238, **0 regressions**).

### Added

#### Browser composables (`sibujs/browser`) — 20 new primitives

- **`visibility()`** — Page Visibility API wrapper. Pause polling / animations while the tab is hidden.
- **`network()`** — Network Information API reactive getters (`effectiveType`, `downlink`, `rtt`, `saveData`). Adapt image quality and prefetching to the real connection, not just online/offline.
- **`mouse({ target?, touch? })`** — reactive pointer position with optional touch unification.
- **`swipe(target, { threshold?, onSwipe? })`** — touch swipe detection with configurable threshold and direction callback.
- **`windowSize()`** — reactive viewport dimensions via the `resize` event (complements the element-scoped `resize()`).
- **`urlState()`** — reactive URL search params + hash with `setParams` / `setHash` backed by `history.pushState`/`replaceState` and `popstate` sync. Independent of `createRouter()`.
- **`broadcast(channelName)`** — BroadcastChannel wrapper exposing a reactive `last` signal and a `post(message)` sender.
- **`fullscreen()`** — Fullscreen API with reactive `isFullscreen` / `element` plus `enter` / `exit` / `toggle`.
- **`wakeLock()`** — Screen Wake Lock API with auto re-acquire on `visibilitychange`.
- **`animationFrame({ fpsLimit?, immediate? })`** — reactive `delta` / `elapsed` driven by `requestAnimationFrame`, with `pause` / `resume` / `dispose` and optional FPS limit.
- **`mutationObserver(target, options)`** — reactive DOM MutationObserver wrapper. Escape hatch for reacting to DOM changes outside the reactive system.
- **`bounds(target)`** — reactive `getBoundingClientRect()`. Updates on resize (ResizeObserver) AND on window scroll (capture-phase passive listener), so absolute top/left stay accurate for overlays.
- **`keyboard({ target?, keys? })`** — reactive set of currently-pressed keys with optional filter. Clears on `window.blur` to avoid stuck modifiers.
- **`speech()`** — Web Speech Synthesis wrapper with reactive `speaking` / `paused` and `speak(text, options)` supporting rate / pitch / volume / voice / lang.
- **`gamepad()`** — Gamepad API as reactive snapshots. Auto-polls via `requestAnimationFrame` only when at least one pad is connected, and emits updates only when button or axis state actually changes (deep equality short-circuit).
- **`pointerLock()`** — Pointer Lock API with reactive `locked` signal and `request(el)` / `exit()`.
- **`vibrate(pattern)`** — thin Vibration API wrapper; returns `false` on unsupported platforms.
- **`favicon(url)` / `svgFavicon(svg)`** — runtime favicon updater. Creates the `<link rel="icon">` if missing; `svgFavicon` encodes inline SVG to a data URI for notification-count badges.
- **`textSelection()`** — reactive text-selection tracker (`text`, `rect`, `hasSelection`, `clear`) for building selection toolbars and citation tools. Syncs via `selectionchange` (mouse drag, Shift+arrow, touch select).
- **`imageLoader(src)`** — reactive image-load status (`"pending"` | `"loaded"` | `"error"`) plus intrinsic `width` / `height`. Prevents CLS in lazy galleries. Gracefully aborts in-flight loads on `dispose()`.

#### Reactivity / core primitives

- **`defer(getter)`** — deferred mirror of a reactive getter. Converges to the source on a microtask + `requestAnimationFrame` so expensive derived views lag behind fast input.
- **`transition()`** — `{ pending, start }` handle that schedules work on `requestIdleCallback` (with rAF / setTimeout fallback). `pending()` stays reactive for both sync and async bodies; exceptions reset the state cleanly.
- **`nextTick()`** — await for DOM flush. Resolves on microtask + rAF so imperative code can read post-render state.
- **`asyncDerived(factory, initial)`** — async counterpart of `derived()`. Reactive `value` / `loading` / `error` triple with stale-response cancellation and a `refresh()` trigger.
- **`createId(prefix?)`** — stable unique id generator for a11y pairing (`aria-labelledby`, `for` + `id`). Exports `__resetIdCounter()` for deterministic tests and SSR.
- **`strict(fn)` / `strictEffect(fn)`** — dev-only double-invocation helpers that surface cleanup bugs (missing disposers, duplicate listeners). No-op in production.
- **`escapeScriptJson(json)`** — exported helper used internally by `serializeState` / `serializeRouteState` / `setStructuredData`. Escapes `<`, `>`, `&`, `U+2028`, `U+2029`.

#### UI helpers (`sibujs/ui`)

- **`interval(fn, ms)`** — declarative `setInterval` handle with `stop` / `pause` / `resume` / `isRunning`.
- **`timeout(fn, ms)`** — declarative `setTimeout` handle with `cancel` / `isPending`.
- **`hover(target)`** — reactive hover tracker using `pointerenter` / `pointerleave` (touch-friendly).
- **`scrollLock()`** — stacked body scroll lock that compensates for scrollbar width. Multiple concurrent overlays each own a handle; only the last `unlock()` restores the original styles.
- **`formAction(fn)`** — async form-action wrapper: reactive `pending` / `error` / `result` / `reset` / `onSubmit`. `onSubmit` is a ready-to-attach `<form>` handler that builds a `FormData` and invokes the action. Stale-response guard drops older in-flight calls on re-submit.
- **`createFocusManager(container, options?)`** — headless focus walker (`focusFirst` / `focusLast` / `focusNext` / `focusPrev`) with optional loop wrap-around.
- **`createListbox(container, options?)`** — full ARIA listbox wiring: `role="listbox"`, `aria-activedescendant`, Arrow / Home / End / Enter / Space keyboard navigation, click-to-select, multi-select. Stamps stable ids on every option via `createId()`.
- **`createDialogAria(element, options?)`** — returns stable `titleId` / `descriptionId`, sets `role="dialog"` (or `"alertdialog"`), `aria-modal`, `aria-labelledby` / `aria-describedby`, `tabindex="-1"`. Intentionally decoupled from focus trap and Escape-to-close.

#### Router

- **`LazyRoute` shorthand** — `{ path: "/page", lazy: () => import("./Page") }` is now accepted as a route definition. `createRouter()` and `setRoutes()` normalize the route tree recursively, so nested children get the shorthand too.

#### Hydration + SSR

- **`hydrate(component, container, { diagnostics, onMismatch })`** — dev-mode tree walker that reports the first tag / attribute / child-count / missing-child mismatch. Internal markers (`data-sibu-ssr`, `data-sibu-hydrated`, `data-sibu-island`) are excluded. Stops after five findings to prevent log spam on a broken tree.
- **`HydrateOptions`** and **`HydrationMismatch`** types exported from `sibujs/ssr`.
- **`renderToSuspenseStream(element, pending, { nonce? })`** — new `nonce` option propagated to the swap scripts for strict-CSP compatibility.
- **`serializeState(state, nonce?)`** / **`serializeRouteState(state, nonce?)`** — optional `nonce` argument for strict-CSP.

#### Components

- **`ErrorDisplay(props)`** — shared rich error UI with copy-to-clipboard (full message + stack + cause + metadata + env), colored severity header (`error` / `warning` / `info`), colored error-code badge (from `error.code` or `error.name`), parsed stack frames (Chrome/V8 + Firefox/Safari formats), `Error.cause` chain walked recursively, metadata + environment sections (URL, UA, ISO timestamp), optional retry + reload buttons. Dev/prod split — stack and metadata hidden in prod unless `alwaysShowDetails: true`.
- **`ErrorBoundary`** — new `resetKeys: Array<() => unknown>` prop. When any listed reactive getter changes after an error has been caught, the boundary auto-resets and re-renders the subtree.

#### Devtools

- **`captureSignalGraph()`** — synchronous snapshot of every observed signal node (id, kind, value preview, subscribers, dependencies, eval count). Empty snapshot when devtools are not enabled so tests and production code can call it unconditionally.
- **`diffSignalGraphs(before, after)`** — classifies nodes into `added` / `removed` / `reevaluated`. Useful for regression assertions like "navigating to /page X must not add more than N new signals".
- **`createTraceProfiler()`** — subscribes to `effect:start` / `effect:end` / `signal:set` events and emits a Chrome tracing JSON blob via `stopTrace()`. Drop the output into `chrome://tracing` or `ui.perfetto.dev` for a flamegraph. Distinct from the existing `createProfiler()` in `componentProfiler.ts`, which tracks per-component render counts.

#### Testing (`sibujs/testing`)

- **`queryByText` / `queryByTestId` / `queryByRole` / `queryByLabel`** — non-throwing finders.
- **`findByText` / `findByTestId` / `findByRole`** — async finders that poll until `timeout`.
- **`waitForSignal(getter, predicate, { timeout })`** — signal-aware wait. Subscribes to the getter and resolves immediately when the predicate matches, instead of polling.
- **`type(element, text)`** — dispatches one `InputEvent` per character + a final `change` event for realistic keyboard simulation.

#### Tag factory ergonomics

- **`tag(props, children)` positional shorthand** — every tag factory now accepts the children as an optional second argument. This removes the last reason to write `nodes:` in nested trees:

  ```ts
  div({ class: "page" }, [
    h1({ class: "title" }, "Welcome"),
    div({ class: "row" }, [
      label({ for: "email" }, "Email"),
      input({ id: "email", type: "email" }),
      button({ class: "primary", type: "submit" }, "Submit"),
    ]),
  ])
  ```

  All legacy forms (`tag({...props})`, `tag("className", children)`, `tag("text")`, `tag([...])`, `tag(node)`, `tag(() => child)`) continue to work unchanged. When both `props.nodes` and the positional second-arg are present, the positional wins.
- **Per-element typed prop overloads** — `a`, `input`, `img`, `button`, `form`, `select`, `textarea`, `label`, `option`, `video`, `audio` now have element-specific prop interfaces (`AnchorProps`, `InputProps`, `ButtonProps`, `FormProps`, `SelectProps`, `TextareaProps`, `LabelProps`, `OptionProps`, `ImgProps`, `VideoProps`, `AudioProps`, `MediaProps`, `InputType`) with full IDE autocomplete and typo detection. Runtime unchanged; the stronger typing is a zero-cost `TypedTagFunction<Props, El>` cast inside `html.ts`. The `[attr: string]: unknown` escape hatch is preserved for custom attributes.
- **`TypedTagFunction<Props, El>`** type exported for building custom typed factories.

#### Persistence

- **`persisted(key, initial, options)`** — new `syncTabs` option (default `true` for localStorage). Listens to the `storage` event so changes in one tab propagate to others. Reentry-guarded against bounce-back. `null` newValue from another tab resets to `initial`.
- The returned setter now carries a non-enumerable **`dispose()`** method that removes the cross-tab listener — previously there was no way to clean it up.

### Changed

- **Tag factory dispatch rewritten** — strings / numbers / arrays / nodes / functions each own an explicit branch, and the props-object path resolves children as `second ?? props.nodes`. Unblocks the `tag(props, children)` shorthand at every level of the tree. No hot-path regression — the fast paths for `tag()`, `tag("text")`, and `tag([...])` still short-circuit.
- **`ErrorBoundary`**'s default fallback is now rendered by `ErrorDisplay`. The legacy inline renderer and its local stack parser were removed. Any `ErrorBoundary` without a custom `fallback` prop gets the richer UI automatically.
- **`withSSR(fn)` is nesting-safe** — saves the prior SSR flag into `wasSSR` and only calls `disableSSR()` on exit when the outer scope was not already in SSR mode. A nested `withSSR(...)` call that throws no longer flips the outer scope's SSR flag back to `false`.
- **`routerSSR.renderRouteToDocument`** delegates meta/link/bodyAttrs validation to the shared hardened helper from `platform/ssr.ts` — the hand-rolled duplicate escaping functions are removed.
- **`tsconfig.json`** adds `"lib": ["ES2022", "DOM", "DOM.Iterable"]` so `Object.hasOwn` resolves while keeping `target: ES2020`.

### Fixed

- **`ErrorBoundary` `resetKeys` edge-cases** — a key-getter that throws is treated as a valid reactive dependency and does not crash the effect.
- **`bindAttribute`** refuses `on*` event-handler attribute bindings with a dev-mode warning that suggests the safe `on: { click: fn }` prop instead. Previously, `bindAttribute(el, "onclick", () => "alert(1)")` would call `setAttribute("onclick", ...)` and turn the string into inline JS.
- **`machine(...)` context merge** — replaced `{ ...ctx, ...patch }` with a filtered loop that drops `__proto__` / `constructor` / `prototype` keys. Prevents prototype pollution from action-returned patches parsed out of JSON.
- **`scopedStyle()`** — CSS sanitizer now decodes CSS hex escapes (`\75 rl(` → `url(`) before the dangerous-pattern scan, closing the obfuscation bypass for `url()` / `expression()` / `@import` / `-moz-binding` / `behavior`.
- **`persisted()`** — the cross-tab `storage` listener can now be cleaned up via a non-enumerable `dispose()` method on the returned setter.
- **`routerSSR.parseURL`** — wraps `decodeURIComponent` in a try/catch so malformed percent-sequences no longer crash SSR (DoS vector). `params` and `query` now use `Object.create(null)` and filter forbidden keys.

### Security

A complete OWASP audit beyond the top 10 was performed, with three review passes and 74 dedicated security tests.

**A01 Broken Access Control**

- **Router `navigate()`** — refuses `javascript:`, `data:`, `vbscript:`, and `blob:` URIs at **every** entry: the top-level `navigate()` call, `beforeEach` guard redirects, `beforeEnter` guard redirects, `route.redirect`, and `beforeResolve` guard redirects. Previously these could land in `history.state` and be reflected into anchor hrefs.

**A02 Cryptographic Failures**

- **`persisted()`** JSDoc no longer references a "simple XOR cipher for illustration" — the example now clearly states that XOR and `btoa()` / `atob()` are NOT encryption and points to AES-GCM via the Web Crypto API.
- **`persisted()`** cross-tab listener now cleanable (see Fixed).

**A03 Injection (XSS / prototype pollution / CSS injection)**

- **`renderToString` / `renderToStream`** — attribute names validated against `^[A-Za-z_:][-A-Za-z0-9_.:]*$`; `on*` event-handler attributes dropped; URL-bearing attributes (`href`, `src`, `action`, `formaction`, `cite`, `poster`, `background`, `srcset`, `ping`, `manifest`, `data`, `xlink:href`) routed through `sanitizeUrl`; attribute values escaped against both `"` and `'`; `<script>` and `<style>` elements stripped from the serialized output; comment-terminator forms (`-->`, `--!>`, `<!--`, trailing `--`) escaped inside comment bodies.
- **`renderToDocument`** — meta / link / bodyAttrs attribute names validated via `buildAttrString`; `on*` keys dropped; URL attributes pass through `sanitizeUrl`; `<meta http-equiv="refresh" content="0;url=javascript:…">` detected and refused via `isDangerousMetaRefresh`; the page `title` is HTML-escaped; script `src` entries go through `sanitizeUrl`.
- **`serializeState` / `serializeRouteState` / `setStructuredData`** — JSON payloads escaped against `<`, `>`, `&`, `U+2028`, `U+2029` so nothing inside a string literal can close the `<script>` tag or break out of JS string context on pre-ES2019 engines.
- **`suspenseSwapScript(id)`** — ids validated against `^[A-Za-z0-9_-]+$` and rejected otherwise. Previously a crafted id could inject context-breakers into the CSS selector or the JS string literal.
- **`bindAttribute`** — refuses `on*` event handlers (defense-in-depth — the tag factory already filters them, but `bindAttribute` is exported and could be called directly).
- **`machine(...)`** — filtered prototype-pollution keys from action-returned context patches.
- **`scopedStyle`** — CSS escape-sequence obfuscation bypass fixed (see Fixed).

**A10 Server-Side Request Forgery (client-side analogue)**

- **`socket()`** — `validateWsUrl()` restricts WebSocket URLs to `ws://` / `wss://` and strips control characters that would bypass a naïve `startsWith` check.
- **`stream()`** — `validateSseUrl()` routes EventSource URLs through `sanitizeUrl()` to block `javascript:` / `data:` / `blob:`.

**CWE-1321 Prototype pollution**

- **`routerSSR.parseURL`** — `params` and `query` created with `Object.create(null)`; `__proto__` / `constructor` / `prototype` filtered from both query-string parsing and pattern-captured route params.
- **`hydrateIslands` / `hydrateProgressively`** — island lookups go through `Object.hasOwn` instead of direct indexing. A `data-sibu-island="__proto__"` marker cannot resolve to `Object.prototype`.

**Head tag hardening**

- **`Head`** — meta / link / script attribute names validated; `on*` keys rejected; `base.href` routed through `sanitizeUrl` (an attacker-controlled base href could otherwise rewrite every relative URL on the page into a `javascript:` URI); `setStructuredData` escapes JSON via the shared `escapeScriptJson`; `<meta http-equiv="refresh">` with a dangerous URL dropped entirely.

### Testing

- **+238 tests, 0 regressions**. Full suite: **2113 / 2113 passing** (baseline was 1875).
- 74 dedicated security tests across `ssr-security.test.ts` (38), `head-security.test.ts` (11), `ssr-context.test.ts` (4), and `owasp-security.test.ts` (21).
- 10 new feature-test files covering concurrent primitives, `formAction`, `strict`, `ErrorBoundary resetKeys`, router `lazy` shorthand, hydration diagnostics, a11y primitives, testing queries, `ErrorDisplay`, and the devtools signal graph.
- New `shorthand-nested.test.ts` (10 tests) locks in the `tag(props, children)` dispatch including deep nesting, string/array/node/function second-args, positional-override-of-`nodes`, and legacy form compatibility.

---

## [1.2.0] — 2026-04-09

### Added

- **Inline lint disable comments** — The `no-direct-dom-mutation` rule (in both the build-system linter and `sibujs lint` CLI) now supports two inline disable forms:
  - `// sibujs-disable-next-line no-direct-dom-mutation` on the line above
  - `// sibujs-disable no-direct-dom-mutation` on the same line

### Fixed

- **Cached element DOM corruption in reactive `nodes`** — `bindChildNode` used a naive "remove all, insert all" strategy with no identity tracking. Returning the same `HTMLElement` instance from a reactive function across re-evaluations could cause duplicates or disappearing elements. The reconciler now builds a reuse set, skips removal of reused nodes, and computes the insertion anchor after cleanup to prevent stale references.
- **Boolean `false` silently ignored in tag factory attributes** — Passing `false` for an attribute (e.g., `textarea({ spellcheck: false })`) was silently skipped instead of removing the attribute. Boolean handling now matches the reactive `bindAttribute` behavior: `true` sets an empty attribute, `false` calls `removeAttribute()`, and IDL properties (`checked`, `disabled`, `selected`) are set as DOM properties directly.

---

## [1.1.0] — 2026-04-06

### Added

- **`Accessor<T>` brand type** — All reactive getters returned by `signal()`, `derived()`, `memo()`, `memoFn()`, `writable()`, `array()`, and `reactiveArray()` are now typed as `Accessor<T>` instead of the plain `() => T`. The brand is purely a compile-time phantom (zero runtime cost) and makes signal getters clearly distinguishable from regular functions in IDE hover tooltips and type signatures. `NodeChildren` and `NodeChild` have been updated to explicitly list `Accessor<NodeChild>` alongside the plain arrow-function form.

### Fixed

- **`isDev()` unsafe default** — The fallback when neither `globalThis.__SIBU_DEV__` nor the compile-time `__SIBU_DEV__` constant is set now evaluates `process.env.NODE_ENV !== "production"` instead of hard-coding `true`. In a browser environment without a Vite build (where `process` is undefined), this resolves to `false`, preventing DevTools from being silently active in production.
- **Prototype pollution in `globalStore`** — The `dispatch()` function now strips `__proto__`, `constructor`, and `prototype` keys from the action patch before spreading it into state. Previously a malicious or malformed action could pollute `Object.prototype` via `{ "__proto__": { isAdmin: true } }`.
- **`workerFn` / `worker()` CSP documentation** — Added a prominent JSDoc warning documenting that the inline worker pattern serializes functions via `.toString()` into a `blob:` URL (equivalent to `eval()`), is incompatible with strict `worker-src 'self'` CSP directives, and must never receive user-controlled or dynamically constructed function arguments.

---

## [1.0.9] — 2026-04-03

### Fixed

- **`when()` condition type widened to generic `T`** — The runtime already uses `===` identity comparison to decide re-renders, supporting non-boolean values (e.g. string IDs, object references). The TypeScript signature now reflects this: `when<T>(condition: () => T, ...)` instead of `when(condition: () => boolean, ...)`. Removes the need for `as unknown as () => boolean` casts.

### Changed

- **Enforce LF line endings** — Added `.gitattributes` with `* text=auto eol=lf` to prevent CRLF formatting drift on Windows.

---

## [1.0.8] — 2026-04-03

### Changed

- **`each()` render callback receives reactive getters** (**BREAKING**) — The render function signature changed from `(item: T, index: number)` to `(item: () => T, index: () => number)`. When a keyed item's data changes but its key stays the same, the DOM is reused without re-calling render — so the old plain-value parameter was a stale snapshot. The new getters are backed by a `keyIndexMap` updated on every reconciliation pass, ensuring they always return fresh data from the current array. **Migration:** add `()` after the item/index parameter wherever it is accessed inside the render callback.

### Added

- **`hotkey()` string combo syntax** — Supports `hotkey("ctrl+shift+z", handler)` in addition to the existing explicit-flags style. Recognized modifiers: `ctrl`/`control`, `shift`, `alt`, `meta`/`cmd`/`command`.
- **`hotkey()` `preventDefault` option** — `hotkey("ctrl+s", handler, { preventDefault: true })` calls `e.preventDefault()` automatically before invoking the handler.

---

## [1.0.7] — 2026-04-01

### Added

- **Nested Route Protection** — `beforeEnter` guards now evaluate for every segment in the matched route chain. Previously, only the leaf route's guard was checked. This ensures that parent layout protection (e.g., `/dashboard`) is respected regardless of which nested child is accessed.
- **Direct Access Protection** — The router now executes guard checks on initial page load and `popstate` events. Navigating directly to a protected URL will now trigger redirects before the component renders.

### Improved

- **Documentation Overhaul** — The `README.md` has been streamlined and now points to the official [sibujs.dev](https://sibujs.dev/) website.
- **Authoring Guide** — Added a clear comparison of the three supported component authoring styles (Tag Factory, Shorthand, and HTML Templates).

---

## [1.0.6] — 2026-03-29

### Fixed

- **`RouterLink` preserves user `class` prop** — The `class` prop was being discarded because the reactive effect overwrote `className` with only the active/exact classes. Now the base class is captured from props and always prepended, so user classes persist and active classes are appended on top. When inactive, the element retains its original class instead of becoming an empty string.

---

## [1.0.4] — 2026-03-28

### Added

- **`bindField()` helper** (`sibujs/ui`) — One-liner to wire a `FormField` to any input, select, or checkbox. Handles `value`, `input`, `change`, and `blur` events automatically. Accepts extra props (placeholder, class, etc.) as a second argument.
- **Toast severity shortcuts** — `toast()` now returns `.info()`, `.success()`, `.error()`, and `.warning()` convenience methods alongside the existing `.show()`.
- **`KeepAliveRoute()` component** (`sibujs/plugins`) — Route outlet that caches rendered components using LRU eviction, preserving signals, form state, and scroll position across navigations. Configurable via `RouterOptions.keepAlive` (boolean, string[], or number) or per-outlet options.
- **`RouterOptions.keepAlive`** — New router option to enable route-level KeepAlive caching. Accepts `true` (cache all), a string array of route names, or a number (max cache size).
- **`copyOnClick` action** — Copies element text (or custom getter value) to clipboard on click. Usage: `action(el, copyOnClick)`.
- **`autoResize` action** — Auto-grows a textarea to fit its content on input. Usage: `action(el, autoResize)`.

### Changed

- **`show()` accepts `Element`** — Signature widened from `show(condition, element: HTMLElement): HTMLElement` to `show<T extends Element>(condition, element: T): T`. Eliminates the `as HTMLElement` cast required on every call since tag factories return `Element`.
- **`contentEditable` uses modern Selection/Range API** — Replaced deprecated `document.execCommand()` with `range.surroundContents()` for bold/italic/underline. Supports toggle (unwrap) when already formatted. The `execCommand` method has been removed from the public API.
- **`renderToDocument()` `headExtra` requires `TrustedHTML`** — Now accepts a branded `TrustedHTML` type instead of plain `string`. Use `trustHTML()` to wrap developer-controlled HTML. Prevents accidental injection of unsanitized user input at compile time. Same change applied to `routerSSR`.

### Security

- **`scopedStyle()` CSS sanitization** — Strips `url()`, `@import`, `expression()`, `-moz-binding`, and `behavior` from CSS before injection. Prevents data exfiltration via attribute selectors and network requests.
- **`persisted()` encryption docs** — Removed misleading `btoa()`/`atob()` example (Base64 is encoding, not encryption). Updated guidance to recommend `crypto.subtle` / AES-GCM.
- **`TrustedHTML` branded type** — New `TrustedHTML` type and `trustHTML()` factory exported from `sibujs/ssr`. Enforces type-level safety for raw HTML injection points.

### Fixed

- **`bindField()` extras no longer clobber event handlers** — Passing `{ on: { click: handler } }` as extras now merges with the field's `input`/`change`/`blur` handlers instead of replacing them. Extras `value` is also ignored to prevent overriding the field getter.
- **`KeepAliveRoute` memory leak** — Evicted nodes are now properly `dispose()`d. Non-cached routes are disposed when navigating away. Cleanup function disposes all cached nodes.
- **`contentEditable` selection restore** — After unwrap, selection now targets the actual unwrapped content range instead of the parent container. After wrap, selection targets the wrapper's contents instead of `document.body`.
- **`sanitizeCSS` `url()` bypass** — Regex now handles quoted strings (`url("...")`, `url('...')`) as opaque tokens, preventing bypass via closing paren inside quotes.

---

## [1.0.3] — 2026-03-28

### Added

- **Wider `NodeChild` / `NodeChildren` types** — `NodeChild` now accepts `boolean`; `NodeChildren` accepts nested arrays and full reactive functions. Conditional patterns like `condition && element` work without `as any` casts. Boolean values are filtered out in `appendChildren`, `bindChildNode`, `Fragment()`, `htm.ts`, and `resolveChild`.
- **`onCleanup()` lifecycle hook** — `onCleanup(callback, element)` registers teardown logic (closing sockets, clearing timers, removing listeners) tied to an element's disposal. Integrates with the existing `dispose()` system so cleanup runs automatically when `when()`, `match()`, or `each()` swap content.
- **`query()` `select` option** — Optional `select` function that transforms cached data before returning it to consumers. Raw response stays in cache; `select` runs on read, enabling derived views without extra signals.
- **`formatNumber()` and `formatCurrency()`** — `Intl`-based formatting utilities exported from `sibujs/browser`. `formatNumber` wraps `Intl.NumberFormat`; `formatCurrency` is a convenience shorthand that sets `style: "currency"`.

### Fixed

- **Boolean values no longer render as text** — `false`, `true` are filtered in all rendering paths (`tagFactory`, `bindChildNode`, `Fragment`, `htm.ts`, `resolveChild`) preventing visible `"false"` text nodes.
- **Lint fixes** — Resolved unused variable in `router.basic.test.ts` and formatting issues flagged by Biome.

---

## [1.0.2] — 2026-03-27

### Fixed

- **`clearQueryCache()` now resets active queries** — Active subscribers get their signals reset (`data`, `error`, `isFetching`) and automatically refetch, instead of silently going stale.
- **`query()` cache entry recovery** — `doFetch()` recreates the cache entry if it was evicted mid-flight, preventing silent fetch failures.
- **`onCacheUpdate` handles missing entries** — Gracefully resets signals when a cache entry is cleared instead of bailing out silently.
- **`setData` propagates `undefined`** — `onCacheUpdate` now correctly syncs `undefined` data from cleared cache entries instead of skipping the update.

### Added

- **CI workflow** (`ci.yml`, `on: [pull_request]`) — GitHub Actions pipeline on pull requests: lint, test, and build (Node 20).

---

## [1.0.1] — 2026-03-27

### Security

- **DevTools disabled by default in production** — `initDevTools()` now defaults to `enabled: isDev()`. Production builds get a no-op API unless explicitly opted in, preventing signal/state exposure via `window.__SIBU_DEVTOOLS__`.
- **SSR error comments no longer leak internals** — Production renders `<!--SSR error-->` without the error message. Dev mode retains full details for debugging.
- **ErrorBoundary hides error details in production** — Default fallback shows a generic message instead of `err.message`, preventing exposure of file paths, DB strings, or stack traces.
- **CSP nonce support for SSR inline scripts** — `suspenseSwapScript(id, nonce?)` and `serializeState(state, nonce?)` accept an optional nonce for strict Content Security Policy compliance.
- **CSS injection guard** — New `sanitizeCSSValue()` blocks `url()`, `expression()`, `javascript:`, and `-moz-binding` in style property values. Applied automatically in `tagFactory` style bindings.
- **`persisted()` encryption support** — New `encrypt`/`decrypt` options for data-at-rest protection in localStorage/sessionStorage.
- **SSR state deserialization validation** — `deserializeState(validate?)` accepts an optional type guard to reject tampered payloads.

---

## [1.0.0] — 2026-03-27

### Added

- **`KeepAlive`** — Caches component DOM subtrees by key, preserving reactive bindings when switching views. Supports LRU eviction via `{ max }` option. Unlike `when()`/`match()`, toggling does NOT dispose the previous branch — scroll position, form state, and signal subscriptions survive.
- **`action()`** — Reusable element-level behaviors with automatic disposal. Built-in actions: `clickOutside` (close on outside click), `longPress` (sustained press detection), `trapFocus` (keyboard focus trapping for a11y). Custom actions return a cleanup function.
- **`writable()`** — Computed with setter. Combines a `derived()` getter with a user-provided setter for two-way computed state. Setter is automatically batched.
- **`springSignal()`** — Reactive spring-animated value with physics simulation (stiffness, damping, precision). Animates toward target via `requestAnimationFrame`. Respects `prefers-reduced-motion` (snaps instantly). Returns `[get, set, dispose]` tuple. Import from `sibujs/motion`.
- **`on()`** — Explicit dependency specification for effects. Only the deps getter is tracked; the handler runs untracked. Provides `(value, prev)` callback signature.
- **`untracked()`** — Execute a function without tracking signal reads as dependencies. Wraps the internal `suspendTracking()`/`resumeTracking()` pair.
- **`signal()` `equals` option** — Custom equality function via `signal(value, { equals: (a, b) => boolean })`. Defaults to `Object.is()`. `deepSignal` refactored to delegate to `signal()` with `equals: deepEqual`, eliminating code duplication.
- **`effect()` `onError` option** — Optional error handler via `effect(fn, { onError: (err) => ... })`. Zero overhead when not provided (no wrapper closure).

### Changed

- **`batch()` returns the callback's value** — Signature changed from `(fn: () => void): void` to `<T>(fn: () => T): T`. Existing code is unaffected (void return still works).
- **`deepSignal` refactored** — Now delegates to `signal()` with `equals: deepEqual`. Gains devtools support for free. `deepEqual()` is now exported for reuse.

### Fixed

- **Notification queue isolation** — One failing subscriber no longer crashes remaining subscribers. All subscriber invocation points in `track.ts` are wrapped in `safeInvoke()` with dev-mode warnings.
- **Dev-mode warnings in silent binding catches** — `bindAttribute` and `bindChildNode` now log `devWarn()` instead of silently swallowing errors. Zero cost in production (tree-shaken).
- **Lifecycle error protection** — `onMount`/`onUnmount` callbacks wrapped in `safeCall()` — throwing callbacks no longer crash the microtask queue or MutationObserver.
- **Per-item error isolation in `each()`** — A throwing render function for one item no longer kills the entire list. Failed items render as comment node placeholders; other items render normally.
- **SSR error handling** — `renderToString`, `renderToStream`, and `renderToDocument` now catch errors per child node, rendering `<!--SSR error: ...-->` comments instead of crashing the server. Error messages are HTML-escaped for security.

---

## [1.0.0-beta.7] — 2026-03-26

### Changed

- **derived() re-tracks dependencies on re-evaluation** — `computedGetter` now uses `track()` instead of `suspendTracking()` when re-evaluating, so derived-of-derived chains propagate correctly. Formula cells like `=SUM(F2:F4)` where F2 is itself `=SUM(B2:E2)` now update automatically.
- **propagateDirty simplified** — removed eager evaluation path; dirty flags propagate through the chain and lazy pull via `computedGetter` + `track()` handles re-evaluation with correct dependency registration.

### Added

- **`lazyEffect()`** — `import { lazyEffect } from "sibujs/ui"` — creates effects that only activate when the target element is visible (via IntersectionObserver). When the element leaves the viewport, the effect is disposed. Ideal for large grids with thousands of cells.
- Spreadsheet showcase demo upgraded: safe math parser (CSP-safe, no `eval`/`new Function`), circular reference detection (`#CIRC`), `lazyEffect` for scalable cell rendering

---

## [1.0.0-beta.6] — 2026-03-26

### Changed

- **ref() is now reactive** — reading `.current` tracks dependencies, writing `.current` notifies subscribers. Works directly with `resize()`, `draggable()`, `dropZone()`, and other APIs that accept reactive getters
- **Browser APIs accept ref or getter** — `resize()`, `draggable()`, `dropZone()` now accept `Ref<HTMLElement> | (() => HTMLElement | null)`
- **debugValue() is now reactive** — uses `effect()` internally to track signal changes; returns a dispose function
- **Router lazy() uses symbol marker** — `isAsyncComponent` now checks `Symbol.for("sibujs:lazy")` instead of relying on `AsyncFunction` constructor name heuristic
- **Widget reactive accessor methods** — `tabs().isActive(id)`, `accordion().isExpanded(id)`, `datePicker().isSelected(date)` — safe to use inside `each()` render callbacks

### Added

- **`onElement` prop** in tag factories — `input({ onElement: (el) => mask.bind(el) })` — called after element creation for imperative bindings
- 93+ interactive examples in sibujs-test covering every module
- 10-tab examples page in sibujs-web (Showcase, Core, Data, Browser, Patterns, Motion, UI & Widgets, Plugins, DevTools, Performance)
- Spreadsheet showcase demo (reactive formulas, SUM, keyboard navigation, cell editing)

## [1.0.0-beta.5] — 2026-03-26

### Fixed

- Comprehensive framework review: fix 23 bugs, clean up module structure
- Update documentation and module exports

---

## [1.0.0-beta.4] — 2026-03-26

### Fixed

- Correct subpackage import paths in README and documentation
- Update package references across all entry points

---

## [1.0.0-beta.3] — 2026-03-25

### Fixed

- Handle array expressions in `html` tagged template engine
- Documentation updates

---

## [1.0.0-beta.2] — 2026-03-25

### Changed

- Optimize reactivity core, `tagFactory`, and `html` template engine for performance
- General improvements and cleanup

### Fixed

- Update all references to match current `sibujs` API (renamed from old `sibu` naming)

---

## [1.0.0-beta.1] — 2026-03-20

Initial public beta release.
