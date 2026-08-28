# Attribute Security

Every way an application can write a DOM attribute in SibuJS reaches the **same
security verdict**. That sentence is the whole design, and it is an invariant
rather than a convention: it is asserted by a cross-writer certification suite,
not left to reviewer discipline.

## Why parity is the property that matters

A missing sanitizer on one code path is a bug. *Two paths that disagree* is a
worse thing, because it turns a routine refactor into a vulnerability:

```ts
bindAttrs(a, { href: url });          // was: raw setAttribute — javascript: shipped
bindAttrs(a, { href: () => url });    // was: sanitized — javascript: blocked
```

Identical intent, identical data, opposite outcomes. Nothing in the application
changed except the shape of the expression. The same held between the HTML tag
factory and `svgElement()`: `div({ onload: "alert(1)" })` was refused while
`svgElement("svg", { onload: "alert(1)" })` installed a live handler.

So the framework does not ask "is this path sanitized?" — it asks "does this
path go through the one writer?"

## The commit primitive

`src/utils/setSafeAttribute.ts` is the single place an attribute value becomes
DOM. It is not a new sanitizer: the policy lives in `src/utils/sanitize.ts`
(`isEventHandlerAttr`, `sanitizeAttributeString`, and the `sanitizeUrl` /
`sanitizeSrcset` / `sanitizeStyleAttribute` family). The primitive's job is to
guarantee every writer actually runs it.

```ts
setSafeAttribute(el, name, value, options?)
```

In order:

| Case | Behaviour |
|---|---|
| `on*` attribute name | **Refused.** The value would be evaluated as JavaScript. Returns `false`; dev builds warn. |
| `null` / `undefined` | Removes the attribute. |
| boolean | HTML boolean-attribute semantics; `checked` / `disabled` / `selected` write the IDL property, which is where their live state actually is. |
| `value` / `checked` string | IDL property, unless `syncValueProperty: false`. |
| `srcdoc` | **Refused**, and any existing value removed. See below. |
| everything else | `sanitizeAttributeString` — URL allowlist, per-candidate `srcset` validation, `style` declaration-list policy, inert pass-through. |

### Namespaces

Inside the SVG namespace, `xlink:*` and `xml:*` are written with
`setAttributeNS`. A plain `setAttribute("xlink:href", …)` produces an attribute
whose literal name contains a colon and whose namespace is null — which SVG
renderers ignore, so the reference silently fails to resolve. The URL policy
still applies: `xlink:href` is in the URL-attribute set.

### `syncValueProperty`

The one deliberate difference between writers, and it is about correctness, not
security:

- **First render** (`tagFactory`) passes `false`. The content attribute is the
  right sink: it seeds the control's default value and survives a form reset.
- **Live updates** (`bindAttribute`, `bindAttrs`, `enhance`'s reactive `attr`)
  use the default. After the user has typed, the content attribute no longer
  reflects the control's current state, so only the IDL property is visible.

`enhance`'s `attr()` passes `false` as well — it is named for the attribute and
documented to write one.

## `srcdoc` is an HTML-parsing sink, not an attribute

The policy above rests on one assumption: an attribute the browser stores as
text is inert, so `setAttribute` cannot execute anything. That is true of every
attribute except one.

`<iframe srcdoc>` is not stored as text. The browser decodes the value and
**parses it as a complete nested HTML document**, and without a sandbox the
scripts in that document run with the embedding page's origin.

Attribute escaping is not a weaker defence here — it is the wrong layer:

```text
written:  srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"   ← correctly escaped
parsed:   <script>alert(1)</script>                        ← escaping undone
```

The escaping is undone *before* the parse, by design. So the generic writers
refuse the attribute outright rather than trying to make a string safe:

```ts
setSafeAttribute(frame, "SRCDOC", html)   // → false, and any existing value removed
```

Refusal is a postcondition, like `on*`: a writer that names the slot removes
whatever was already in it, so server markup or a third-party widget cannot
leave a live document behind.

Three consequences worth stating explicitly:

- **Sanitizing arbitrary HTML is not attempted.** That is a different and much
  larger problem, and doing it badly is worse than refusing.
- **`TrustedHTML` does not unlock it.** That type is a compile-time brand —
  `trustHTML()` returns the same string through a cast — so it has no runtime
  identity and cannot serve as proof. A trusted-document API would need a
  runtime-verifiable wrapper or browser Trusted Types, and does not exist today.
- **`sandbox` does not unlock it either.** Accepting `srcdoc` when a `sandbox`
  attribute happens to be present would make security depend on an attribute
  any later code can remove.

The rule lives in one place, `isHtmlContentAttribute()` in `utils/sanitize`, and
is consulted by every client writer and every SSR serializer.

### SSR omits it

`renderToString`, the `renderToStream` generator, `buildAttrString`, and the
router's document-attribute builder all drop `srcdoc` rather than escaping it.
The string and streaming renderers are asserted against each other, because a
divergence there is its own bug class — someone streams in production and
snapshots with `renderToString` in tests.

## Dynamic `html` attributes use the shared policy

The tagged-template executor used to carry its own attribute rules: `srcset`,
then URL attributes, then "write it". That list was the shared policy minus
`style`, so `html\`<div style=${untrusted}>\`` never reached the
declaration-list sanitizer even though this document claimed it did.

A duplicated policy is a policy that drifts, so there is now one. Both dynamic
forms commit through `setSafeAttribute`:

```ts
html`<div style=${value}></div>`              // single expression
html`<div style="color:red;${value}"></div>`  // mixed — the ASSEMBLED string
```

Sanitizing the assembled string is what catches attacks split across the
boundary, like `href="java${x}:…"`.

**Fully static template text is deliberately excluded.** An attribute the
developer typed literally into their own source is developer-controlled, at the
same trust level as hand-written markup. Only expressions are runtime data.

## `<meta http-equiv="refresh">` is parsed, not pattern-matched

A refresh directive is a grammar, and the browser's parser accepts many
spellings of it. The previous policy asked whether the lower-cased `content`
*contained* `url=javascript:` (plus three sibling schemes), which recognises
exactly one. Every one of these is a live redirect the substring never saw:

```text
0; url = javascript:alert(1)        whitespace around the separator and `=`
0;URL=JAVASCRIPT:alert(1)           mixed-case key and scheme
0;url='javascript:alert(1)'         quoted destination
0;	url	=	javascript:alert(1)     tabs
```

Pattern-matching a grammar is a losing position — each new spelling needs a new
pattern, and the attacker picks the spelling. So `utils/metaRefresh.ts` extracts
the destination structurally and hands it to `sanitizeUrl()`, the same protocol
authority every other URL sink uses. Adding a scheme to that allowlist now fixes
this sink too, automatically.

The grammar accepted (whitespace runs optional, `url` case-insensitive):

```text
content := WS* delay WS*
         | WS* delay WS* ";" WS* "url" WS* "=" WS* dest WS*
delay   := DIGIT+
dest    := "'"…"'" | '"'…'"' | unquoted-run
```

**This is deliberately stricter than a browser, and does not claim parity with
the WHATWG algorithm.** Real browsers recover aggressively from malformed
directives and differ from one another at the edges; reproducing that would mean
matching recovery behaviour we cannot verify across the whole support floor.
Anything this parser cannot read *unambiguously* is refused instead — an
unterminated quote, competing `url=` assignments, a non-numeric delay, trailing
junk, an empty destination, a key that is not `url`. The cost is that a few
odd-but-harmless directives are dropped; the benefit is that no unreadable
directive is ever emitted on the strength of "no forbidden substring was found".

The decision is a discriminated union — `not-refresh`, `delay-only`, `allowed`,
`forbidden` — because callers act differently on each. A boolean forced
"ignore me, I'm a description tag" and "drop this element" into one answer.

### Duplicate case-insensitive names are rejected

HTML attribute names are case-insensitive; JavaScript object keys are not, so
this object is legal and was the bug:

```ts
{ "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: "0;url=javascript:…" }
```

A helper returning the *first* case-insensitive match validated `x-custom` while
the DOM loop wrote both attributes and the later `HTTP-EQUIV` became effective.
The verdict and the commit were about different entries.

The rule is **rejection**, not precedence. Last-write-wins would also be sound if
the validated value were provably the committed one, but rejection removes the
class of bug rather than re-parameterising it — and duplicate casings in a meta
entry are a mistake in every real case.

### Reactive entries are committed as whole snapshots

`Head()` used to create one effect per reactive *attribute*, so each write was
judged alone. That lets the combination become dangerous while no individual
write ever looks wrong:

```ts
{ "http-equiv": () => equiv(), content: "0;url=javascript:alert(1)" }
```

With `equiv()` initially `"x-custom"` the entry is not a refresh, so the static
content is accepted. `setEquiv("refresh")` re-runs only the `http-equiv` effect —
the content is never revalidated, and the element is now a live redirect nothing
ever approved.

Security decisions are properties of the whole entry, so the whole entry is the
unit of work: one effect per entry resolves every attribute, folds duplicate
casings, and validates the assembled snapshot. A snapshot that fails validation
**withdraws** the element rather than blanking an attribute — a partially cleared
element is still live markup.

### Publication is a swap, not a reconciliation

Validating a whole snapshot is not enough if the snapshot is then applied to a
**connected** element one attribute at a time. Reconciling

```text
http-equiv="x-custom"  content="0;url=javascript:alert(1)"   (old, connected)
```

into the entirely valid

```text
http-equiv="refresh"   content="5;url=/safe"                 (new, approved)
```

writes `http-equiv="refresh"` while the element still carries the old content. For
the duration of one `setAttribute` the document contains a live
`<meta http-equiv="refresh" content="0;url=javascript:alert(1)">` — a pair no
snapshot ever approved, existing only because two safe states were interpolated
through the DOM. Reordering the writes moves the hole rather than closing it:
**attribute order is not a security mechanism.**

So an accepted snapshot is materialised on a *fresh* element while it is
detached, every attribute is set there, and it is published with a single
`replaceWith()` (or `appendChild()` when nothing is attached yet). Every
intermediate state is unobservable because it never touches the document. The
managed-element reference is updated in the same step, so disposal always removes
the element that is live and never leaks the one it replaced.

### Native refresh directives must be static

A browser processes a meta refresh when the element is **inserted**: the document
records that it will declaratively refresh and schedules the navigation right
there. Removing or replacing the element afterwards is not a defined cancellation
mechanism — see the
[HTML refresh processing model](https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-http-equiv-refresh).

That makes "reactive refresh" a promise a framework cannot keep. Once a reactive
entry has published `http-equiv="refresh"`, a later state change that ought to
withdraw it has nothing left to withdraw; the navigation already belongs to the
browser, and a test asserting "the element is gone" is measuring the wrong thing.
The same applies to a safe-to-safe change: the first destination stays scheduled.

The contract is therefore the narrow, honest one:

> A meta entry containing reactive attributes must never publish a snapshot whose
> effective `http-equiv` value is `refresh`.

This is a *publication* rule, not a parse rule. The snapshot is still parsed and
still refused outright if the directive is dangerous; a reactive entry whose
snapshot happens to be a perfectly safe refresh is withheld **anyway**, because
the question is reversibility rather than safety. Concretely:

- a reactive `http-equiv` flipping to `refresh` inserts nothing;
- a static `refresh` with reactive `content` inserts nothing, on first render or
  after;
- a reactive entry that later resolves to an ordinary non-refresh meta publishes
  that ordinary entry normally;
- fully static refresh directives are unaffected — safe ones are emitted, and
  forbidden or ambiguous ones are dropped as before;
- every other reactive meta entry — description, keywords, Open Graph, non-refresh
  `http-equiv` — behaves exactly as it always did.

No framework navigation timer stands in for the withheld directive. Scheduling a
redirect the developer did not ask the *framework* to own would be a larger
promise than the one being withdrawn.

### Attribute names are canonicalized once, then never re-derived

HTML attribute names are ASCII case-insensitive: the parser reads `SRC` as
`src`. Every security classification therefore has to run on a canonical name,
and `head.ts` did not — it carried a private, case-SENSITIVE set:

```ts
const HEAD_URL_ATTRS = new Set(["href", "src"]);
if (HEAD_URL_ATTRS.has(key)) return sanitizeUrl(value);   // `SRC` misses
```

so `Head({ script: [{ SRC: "data:text/javascript,…" }] })` skipped URL
sanitization completely and appended a `<script>` the browser fetched and ran,
while both SSR paths — which lower-cased first — refused the identical value.
`isUrlAttribute()` in `utils/sanitize.ts` already carried a comment warning about
exactly this mistake. `head.ts` simply was not calling it.

There is now one fold, `canonicalAttrName()`, and it is deliberately **ASCII
only**. `String.prototype.toLowerCase` maps some non-ASCII code points *into*
ASCII letters — U+212A KELVIN SIGN becomes `k` — which would make the framework
and the browser disagree about what an attribute is called. The parser
lower-cases exactly `A`–`Z`, so the fold does too. URL sinks, event handlers,
`srcdoc`, and duplicate detection all consult that one string.

### A refused value is omitted, never emptied

`href=""` is not "no href". An empty URL attribute resolves against the current
document, so `<link href="">` references the page itself and `<script src="">`
is a request rather than a no-op. Publishing an empty substitute for a refused
URL is a different document from publishing nothing.

The sanitization contract therefore returns `string | null`, and `null` means
*omit this attribute*. An empty string is only ever a rejection for a **policy
sink** (a URL attribute, `style`, `srcset`); for inert text like `content` or
`id` it is a perfectly legitimate value and is committed as authored.

When nothing survives, the entry itself is dropped — one shared answer rather
than three. The client used to publish an attribute-less `<meta>` where both
servers emitted nothing at all.

### One URL policy, not three

Router SSR carried a `sanitizeUrlLocal` described in its own comment as
mirroring `utils/sanitize.ts`. It did not mirror it: the canonical sanitizer is
an **allowlist** (`http:`, `https:`, `mailto:`, `tel:`, `ftp:`, plus relative
URLs), while the local copy was a **blocklist** of four schemes. Router SSR
therefore emitted `file:`, `about:`, `chrome:` and every custom scheme that
`Head()` and `renderToDocument` both refused.

A comment is not a mechanism. All three paths now call `sanitizeAttributeString`
— the same authority the tag factory and the reactive bindings use — so `<head>`
cannot hold a value the rest of the framework would reject.

### One pipeline, one order

A shared policy function is not the same thing as a shared decision. All three
paths already called one policy and still disagreed, because they called it at
different points in their own pipelines:

```text
client:  filter unsafe names  →  resolve values     →  check duplicates
server:  check duplicates     →  filter unsafe names →  sanitize values
```

So `{ name: "description", content: "ok", onload: "a", ONLOAD: "b" }` was emitted
by the client — which dropped both event handlers as unsafe names and then saw no
duplicate — and rejected by both servers, which saw the duplicate in the raw
record. Same rule, same function, opposite outcomes.

`planMetaEntry` / `planHeadElementEntry` (`utils/headEntry.ts`) fix the order in
one place for all three:

1. reject duplicate case-insensitive names, on the **raw authored names**
2. canonicalize each name
3. drop names that may not be emitted (malformed, `on*`, `srcdoc`)
4. resolve values — the ONE step that differs, since only the client has getters
5. sanitize values, **omitting** rejected ones rather than emptying them
6. drop the entry when nothing effective remains
7. for `<meta>`, validate the complete effective snapshot against the
   meta-refresh policy — what is judged is what is committed

An earlier version of this pipeline took the name filter and the value sanitizer
as *parameters*, so each target supplied its own. That is a shared function, not
a shared decision, and the three promptly diverged in four separate ways — the
case-sensitive URL set, the router's scheme blocklist, `srcdoc` kept on the
client and dropped by both servers, and refused URLs emptied on the client and
omitted by the servers. **Only value resolution is parameterized now.** There is
nothing left for the three paths to disagree about, and the attribute map they
produce is keyed by canonical names, so client DOM and server HTML are directly
comparable rather than merely equivalent.

`tests/security-meta-refresh-parity.test.ts` drives one table through all three
and asserts exact equality — emitted-or-not, attribute count, canonical names,
and values — against a pinned expectation *and* against each other. Comparing
only to each other would let a row they all get wrong pass; comparing only to an
expectation would let drift between them pass.

## Security is a postcondition, not a promise about this write

The rule the primitive enforces is about the **attribute**, not about the call:

> After a SibuJS binding commits to an attribute slot, that slot holds a value
> the policy permits — regardless of what was in it beforehand.

This matters because these APIs attach to DOM that already exists: server
markup, a third-party widget, anything `enhance()` is pointed at. Two things
follow, and both were once wrong.

**Write elision compares the sanitized result.** A caller that compares its raw
desired value against the raw attribute and skips the write when they match will
skip the sanitizer in exactly the dangerous case — `<a href="javascript:…">`
re-bound to that same string. The elision therefore lives *inside* the primitive
and compares post-policy:

```ts
const safe = sanitizeAttributeString(name, str);
if (current === safe) return true;   // nothing to do, and provably safe
```

No caller needs its own, and none should have one.

**A refused `on*` value clears the slot.** Refusing to write a handler is not
the same as ensuring there is no handler. A binding that names `onclick` owns
that slot, so a pre-existing `onclick="alert(1)"` is removed rather than left
behind. `bindAttribute` routes its early refusal through the primitive for this
reason instead of returning early with its own warning — one implementation of
the policy, one behaviour.

Function-valued handlers are unaffected: they were never attributes.

## Attribute-name case

HTML attribute names are case-insensitive, so `VALUE` *is* `value` to the
browser. The IDL-synchronisation decisions (`value`, `checked`, and the boolean
set `checked`/`disabled`/`selected`) therefore fold case — otherwise a binding
declared as `"VALUE"` silently took content-attribute semantics and left a
dirtied control showing stale state.

Folding is **HTML-only**. SVG attribute names are case-sensitive, and
`viewBox`, `preserveAspectRatio` and `patternUnits` are meaningless lowercased;
IDL form-control synchronisation has no meaning there either. The namespace is
what decides.

## Writers

Every one of these commits through the primitive:

| Writer | Entry point |
|---|---|
| Static prop on a tag factory | `src/core/rendering/tagFactory.ts` |
| Reactive attribute binding | `src/reactivity/bindAttribute.ts` (`bindAttribute`, `bindDynamic`) |
| `bindAttrs` — static **and** reactive | `src/ui/reactiveAttr.ts` |
| `bindBoolAttr`, `bindData` | `src/ui/reactiveAttr.ts` |
| `svgElement()` | `src/platform/customElement.ts` |
| `enhance()`'s reactive `attr()` | `src/platform/enhance.ts` |

Function-valued `on*` props keep their existing meaning everywhere —
`addEventListener`, never an attribute. Only *strings* in an `on*` slot are
refused, and they are refused because there is no safe interpretation of one.

## Deliberately raw paths

Two paths write attributes without the runtime policy, and both are trusted **by
construction** rather than by omission:

- **Static attributes in an `html\`\`` template** (`src/core/rendering/htm.ts`,
  the `t === 0` case). The value is a literal the author typed into their own
  source, at the same trust level as writing the markup by hand. *Interpolated*
  attribute values in the same template are runtime data and are sanitized.
- **`<head>` writes** (`src/platform/head.ts`) apply their own stricter policy:
  a name allowlist, URL sanitization on `href`/`src`, and rejection of dangerous
  `http-equiv="refresh"` directives.

If you add a third, document why it is trusted at the call site.

## The certification

`tests/certify-public-wrapper-invariants.test.ts` drives every writer through
one table of dangerous and safe values and asserts two things:

1. no writer lets a dangerous value through, and
2. **all writers produce the identical result** — agreement, not merely
   independent safety.

The second assertion is the one that catches drift. A new writer that blocks
`javascript:` by returning `"about:blank"` instead of `""` would pass a
"is it safe?" test and fail this one, which is correct: divergence is the defect
class this suite exists to prevent.

`tests/hardening-attr-security-parity.test.ts` holds the per-writer detail, and
`tests/hardening-enhance-attr-security.test.ts` covers the enhancement path.
