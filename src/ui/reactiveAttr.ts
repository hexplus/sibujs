import { bindAttribute } from "../reactivity/bindAttribute";
import { track } from "../reactivity/track";
import { setSafeAttribute } from "../utils/setSafeAttribute";

/**
 * Every value the shared attribute primitive accepts, and nothing more.
 *
 * `null` / `undefined` are part of the contract, not an oversight: they REMOVE
 * the attribute. That is what makes the ordinary optional-value getter —
 * `() => user?.label` typed `string | null | undefined` — expressible without a
 * cast. The declared type used to exclude both while the runtime handled them,
 * so the documented behaviour was unreachable from type-checked code.
 *
 * Deliberately NOT widened to `unknown`: the runtime only defines behaviour for
 * these, and a public signature should describe the runtime exactly rather than
 * inviting values whose handling is incidental.
 */
export type AttributeValue = string | number | boolean | null | undefined;

/** An attribute value, or a reactive getter producing one. */
export type AttributeSource = AttributeValue | (() => AttributeValue);

/**
 * Bind multiple reactive attributes to an element.
 * Each attribute value can be a static value or a reactive getter.
 * Returns a single teardown function that stops all bindings.
 *
 * Static and reactive values share ONE security policy. They previously did
 * not: a getter went through `bindAttribute` (which refuses `on*` and sanitizes
 * URL/style/srcset), while a plain string went straight to `setAttribute`. So
 * `bindAttrs(a, { href: "javascript:…" })` was live XSS while the identical
 * `bindAttrs(a, { href: () => "javascript:…" })` was blocked — the same
 * authoring intent with two different verdicts. Both now commit through
 * `setSafeAttribute`.
 */
export function bindAttrs(el: HTMLElement, attrs: Record<string, AttributeSource>): () => void {
  const teardowns: Array<() => void> = [];

  for (const [attr, value] of Object.entries(attrs)) {
    if (typeof value === "function") {
      // Reactive getter — delegate to bindAttribute for tracking. It commits
      // through the same primitive, so the verdict matches the static path.
      const teardown = bindAttribute(el, attr, value as () => unknown);
      teardowns.push(teardown);
    } else {
      // Static value — commit once, through the shared policy. Booleans keep
      // HTML boolean-attribute semantics inside the primitive.
      setSafeAttribute(el, attr, value, { label: "bindAttrs" });
    }
  }

  // Combined teardown that cleans up all reactive bindings
  return () => {
    for (const td of teardowns) {
      td();
    }
  };
}

/**
 * Reactively toggle a boolean attribute (like disabled, readonly, hidden).
 * When the value is truthy the attribute is present (set to ""),
 * when falsy the attribute is removed entirely.
 * Returns a teardown function to stop reactive tracking.
 *
 * The attribute NAME is policed too: `bindBoolAttr(el, "onclick", true)` would
 * otherwise create a live `onclick=""` handler slot through a helper whose
 * whole purpose is inert presence toggling.
 */
export function bindBoolAttr(el: HTMLElement, attr: string, getter: boolean | (() => boolean)): () => void {
  // Static boolean — apply once, no tracking needed
  if (typeof getter !== "function") {
    setSafeAttribute(el, attr, getter, { label: "bindBoolAttr" });
    return () => {};
  }

  // Reactive getter — track changes
  const reactiveGetter = getter as () => boolean;

  function commit() {
    let value: boolean;
    try {
      value = reactiveGetter();
    } catch {
      return;
    }

    setSafeAttribute(el, attr, Boolean(value), { label: "bindBoolAttr" });
  }

  const teardown = track(commit);
  return teardown;
}

/**
 * Bind a data-* attribute reactively.
 * Shorthand for `bindAttribute(el, "data-<key>", getter)`.
 * Returns a teardown function to stop reactive tracking.
 *
 * Shares the removal semantics of every other attribute writer: `null` /
 * `undefined` remove `data-<key>` rather than writing the text "null". The
 * value is handed to the primitive unstringified so that decision is made in
 * one place.
 */
export function bindData(el: HTMLElement, key: string, getter: AttributeValue | (() => AttributeValue)): () => void {
  const dataAttr = `data-${key}`;

  // Static value — set once, no tracking needed
  if (typeof getter !== "function") {
    setSafeAttribute(el, dataAttr, getter, { label: "bindData" });
    return () => {};
  }

  // Reactive getter — delegate to bindAttribute
  return bindAttribute(el, dataAttr, getter as () => unknown);
}
