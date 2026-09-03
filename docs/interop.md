# Running SibuJS islands inside someone else's page

SibuJS does not need to own your page. An island is a `<div>` your server (or
your existing framework) rendered, plus a call to `mountIslands()`. Everything
outside that element stays exactly as it was.

That makes SibuJS adoptable **one widget at a time**: a chess board inside a
component-framework application, a pricing calculator in a CMS template, a
dashboard panel in an admin app that will not be rewritten.

This guide gives the rules once, framework-neutrally, then shows what they look
like in each host. Two of them are verified by tests in this repository; the
rest are the same nine lines with different names.

---

## The nine rules

Every host reduces to the same questions.

### 1. The host owns the island root; SibuJS owns its contents

Your host framework renders the element carrying `data-sibu-island`. SibuJS
attaches bindings to that element and its descendants and **creates no nodes**
unless you call `mount()` yourself.

The rule that follows: **no node may have two owners.** Either the host renders
a subtree and SibuJS enhances it, or SibuJS mounts into an empty container the
host promises not to touch. Never both.

### 2. The host may remove the root — as long as you dispose first

If the host is going to unmount, replace or re-render the island root, call the
disposer **before** it does. After disposal the markup is inert and ownerless,
so the host can do what it likes with it.

If the host removes the node without telling you, nothing catastrophic happens —
`enhance()` also registers its teardown on the element, so a SibuJS-driven
removal (`dispose(node)`) cleans up. But a host that rips the node out with its
own renderer will not call that, so **keep the disposer and call it**.

### 3. Call `mountIslands()` after the host has rendered the markup

Not before. `mountIslands()` scans the DOM it is given; islands that do not
exist yet are not found. In practice that means the host's "the DOM is ready"
hook — a mount effect, a hydration callback, a `DOMContentLoaded`, a
`turbo:load`.

### 4. Keep the disposer and call it exactly once

```ts
const dispose = mountIslands(document);
// …later, before the host replaces the markup:
dispose();
```

The disposer cancels pending activation schedulers (`idle`, `visible`,
`interaction`, `media`) *and* disposes every island that already activated.
Calling it twice is safe.

### 5. Scope the scan when the host owns the rest of the page

```ts
mountIslands(containerEl); // only islands inside this subtree
```

Scoping is what lets two independently-mounted regions coexist without either
one adopting the other's islands.

### 6. Client-side navigation is "dispose, then mount again"

A client-side router replaces DOM without a page load. Treat every navigation as
teardown plus setup:

```ts
onNavigateAway(() => dispose());
onNavigated(() => { dispose = mountIslands(document); });
```

If your host cannot tell you when it is about to swap the DOM, the fallback is
to dispose and re-mount on *every* navigation event you can observe. Re-mounting
is cheap and idempotent.

### 7. Duplicate activation is already prevented — but scan anyway

`mountIslands()` skips any element that currently carries
`data-sibu-enhanced="true"`. So calling it again after the host adds new markup
activates **only the new islands** and leaves the live ones alone. You do not
need to track which islands you have already mounted.

That is what makes the "just call it again after every render" strategy correct
rather than merely convenient.

### 8. Keep feature state inside the island setup

```ts
registerIsland("chess", (ctx) => {
  const game = new Chess();      // ✓ one per island element
  const changed = external();
  …
});

const game = new Chess();        // ✗ shared by every instance on the page
```

State created inside the setup is per-instance and dies with the island. Module
state is shared by every instance, survives disposal, and is the single most
common cause of "the second widget on the page behaves strangely".

### 9. Failures stay inside the island

An island whose setup throws is reported and left with zero bindings and zero
listeners; its siblings activate normally, and the host page never sees the
exception. You do not need a boundary around `mountIslands()`.

---

## Static HTML, or any classic server-rendered page

The baseline case — Django, Rails, Laravel, WordPress, Go templates, Hugo,
Eleventy, PHP, ASP.NET. There is no client-side navigation and no host renderer
competing for the DOM, so rules 1–5 are all you need:

```html
<div data-sibu-island="counter">
  <output data-ref="n">0</output>
  <button data-ref="inc">+1</button>
</div>

<script src="https://unpkg.com/sibujs@latest/dist/cdn.global.js"></script>
<script>
  const { signal, registerIsland, mountIslands } = window.Sibu;
  registerIsland("counter", (ctx) => {
    const [n, setN] = signal(0);
    ctx.text("@n", () => n());
    ctx.on("@inc", "click", () => setN((v) => v + 1));
  });
  mountIslands();
</script>
```

No build step, no bundler, no npm. Emit the markup from whatever templating
language you already use; the `data-ref` attributes are just attributes.

**Per-host notes:**

- **Django / Rails / Laravel** — render the island in a partial/template so the
  markup and its `data-ref` names live next to each other. Pass server data
  through `data-*` attributes on the root and read them with
  `ctx.root.dataset`, rather than emitting a `<script>` blob.
- **WordPress** — enqueue the runtime with `wp_enqueue_script()` and put the
  markup in a shortcode or block template. Because the island claims only its
  own element, it coexists with whatever else the theme and other plugins are
  doing to the page.
- **Turbo / Hotwire / htmx** — these replace DOM on navigation, so they are the
  "classic server" case *plus* rule 6. Dispose on the "before swap" event and
  re-mount on the "after swap" one (`turbo:before-render` / `turbo:load`,
  `htmx:beforeSwap` / `htmx:afterSettle`).

**Verified in this repository:** [`examples/chess/`](../examples/chess/) is a
static page whose islands are exercised across Chromium, Firefox and WebKit by
[`tests-browser/chess.spec.ts`](../tests-browser/chess.spec.ts).

---

## A component-framework server shell (Next.js-style, React, Vue, Svelte)

Here the host has its own renderer, and rule 1 is the one that matters: the host
must not re-render the island's subtree while SibuJS owns it.

The shape that works in every component framework:

1. Render the island markup on the server, as the host normally would.
2. In a client component, render the markup **once** and tell the host's
   renderer to leave it alone.
3. Mount on the component's mount hook; dispose in its teardown.

```tsx
// A client component whose only job is owning the island's lifetime.
"use client";
import { useEffect } from "react";
import { mountIslands, registerIsland } from "sibujs";
import { setupChess } from "./chess-island";

export function ChessIsland() {
  useEffect(() => {
    registerIsland("chess", setupChess);
    return mountIslands(document); // the returned disposer IS the cleanup
  }, []);
  return null;
}
```

Two details do all the work:

- **`return mountIslands(document)`** — the host's cleanup and SibuJS's disposer
  are the same function, so unmounting the component disposes the islands. This
  is rules 2, 4 and 6 satisfied at once, because a client-side navigation
  unmounts the component.
- **The island markup is NOT rendered by this component.** It is server markup
  the host renders once and never updates (no reactive props, no keys that
  change). If the host re-rendered it, the host's renderer and SibuJS would both
  be writing to the same nodes.

If you cannot guarantee the host will leave the subtree alone, give it an empty
container instead and let it render nothing into it:

```tsx
<div ref={hostEl} suppressHydrationWarning />   // React: "this subtree is not mine"
```

…then `mountIslands(hostEl.current)` or `mount()` into it. The equivalents are
`v-once`/`v-html` in Vue and rendering to a bare element you never touch again in
Svelte. The principle is the same in all three: **one owner per node.**

**Scoping.** Prefer `mountIslands(rootEl)` over `mountIslands(document)` when the
host renders several independent regions — it keeps one region's disposer from
being responsible for another region's islands.

---

## Astro

Astro already has an island model, so SibuJS slots in as "a script that
enhances the HTML this component rendered":

```astro
---
// Board.astro — server-rendered markup, no client framework
---
<div data-sibu-island="chess"> … 64 squares … </div>

<script>
  import { mountIslands, registerIsland } from "sibujs";
  import { setupChess } from "../islands/chess";
  registerIsland("chess", setupChess);
  mountIslands(document);
</script>
```

Astro's `<script>` runs after the markup is in the document, which is rule 3.
There is no client-side navigation unless you enable view transitions — if you
do, dispose on `astro:before-swap` and mount on `astro:page-load` (rule 6).

You do **not** need a `client:*` directive: the directive exists to hydrate a
component framework, and there is no component to hydrate.

---

## Anything else

The checklist, in the order you will need it:

1. Where does the island root come from, and who re-renders it? (rule 1)
2. What event fires after that markup is in the DOM? → `mountIslands()` there.
3. What event fires before it is removed or replaced? → `dispose()` there.
4. Does the host navigate without a page load? → do both, every navigation.
5. Is any island state at module scope that should be per-instance? (rule 8)

If a host gives you no "before removal" hook at all, the fallback is a
`MutationObserver` on the container that disposes when the root disconnects. It
is a last resort — the island's own bindings are already released when SibuJS
disposes the node, and what you are really protecting is the resources *your
setup* opened (timers, sockets, observers) via `ctx.cleanup()`.

**Verified in this repository:**
[`examples/interop-host.html`](../examples/interop-host.html) simulates a host
framework that owns the page and swaps its content on client-side navigation,
including the failure mode you get from forgetting the disposer.
[`tests-browser/interop.spec.ts`](../tests-browser/interop.spec.ts) exercises it
in all three browsers.

---

## What SibuJS deliberately does not do here

- **It does not install anything globally.** No document-level delegated
  listeners, no page-wide observers, no framework singleton that has to be
  first. The island registry is a `Map`.
- **It does not claim nodes it was not given.** No portals into `<body>`, no
  wrapper elements, no re-parenting.
- **It does not require a build step.** The CDN build is a `<script>` tag, which
  matters when the host page is a CMS template you cannot add a bundler to.
- **It does not need to be the router.** Two SibuJS islands on a page navigated
  by someone else's router is a supported configuration, not a workaround.
