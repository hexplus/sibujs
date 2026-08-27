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
