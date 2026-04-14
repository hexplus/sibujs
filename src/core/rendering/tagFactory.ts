import { devWarn, isDev } from "../../core/dev";
import { bindAttribute } from "../../reactivity/bindAttribute";
import { bindChildNode } from "../../reactivity/bindChildNode";
import { track } from "../../reactivity/track";
import { isUrlAttribute, sanitizeCSSValue, sanitizeSrcset, sanitizeUrl } from "../../utils/sanitize";
import { registerDisposer } from "./dispose";
import type { NodeChild, NodeChildren } from "./types";

export const SVG_NS = "http://www.w3.org/2000/svg";

const _isDev = isDev();

// Tag names that must never be created via tagFactory — they enable script
// execution or arbitrary plugin loading regardless of attributes. The check
// is case-insensitive and applies to HTML, SVG, and MathML namespaces since
// e.g. <script> exists in both HTML and SVG.
const BLOCKED_TAGS = new Set(["script", "iframe", "object", "embed", "frame", "frameset"]);

function validateTagName(tag: string): void {
  const lower = tag.toLowerCase();
  if (BLOCKED_TAGS.has(lower)) {
    throw new Error(`tagFactory: refusing to create <${tag}> — tag is blocked for security reasons.`);
  }
}

// IDs matching well-known window/document properties are risky due to DOM
// clobbering (a named element can shadow a global). Warn in dev only.
const CLOBBER_RISKY_IDS = new Set([
  "config",
  "location",
  "history",
  "document",
  "window",
  "navigator",
  "name",
  "top",
  "parent",
  "self",
  "frames",
]);

/**
 * Typed property setter that avoids `@ts-expect-error` sprinkled at call sites.
 * Use only when the property is known to exist on the element at runtime.
 */
export function setProp(el: Element, key: string, val: unknown): void {
  (el as unknown as Record<string, unknown>)[key] = val;
}

export interface TagProps {
  id?: string;
  class?: string | (() => string) | Record<string, boolean | (() => boolean)>;
  style?: Record<string, string | number | (() => string | number)> | string | (() => string);
  ref?: { current: Element | null };
  nodes?: NodeChildren;
  on?: Record<string, (ev: Event) => void>;
  /** Called with the element after creation — useful for imperative bindings */
  onElement?: (el: HTMLElement) => void;
  [attr: string]: unknown;
}

// Cache for camelCase → kebab-case conversions
const kebabCache = new Map<string, string>();

function toKebab(prop: string): string {
  let cached = kebabCache.get(prop);
  if (cached !== undefined) return cached;
  cached = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  kebabCache.set(prop, cached);
  return cached;
}

function applyStyle(el: Element, style: TagProps["style"]) {
  if (typeof style === "function") {
    const teardown = track(() => {
      el.setAttribute("style", (style as () => string)());
    });
    registerDisposer(el, teardown);
    return;
  }

  if (typeof style === "string") {
    el.setAttribute("style", style);
    return;
  }

  const htmlEl = el as HTMLElement;
  for (const prop in style as Record<string, string | number | (() => string | number)>) {
    const val = (style as Record<string, string | number | (() => string | number)>)[prop];
    const name = toKebab(prop);
    if (typeof val === "function") {
      const getter = val as () => string | number;
      const teardown = track(() => {
        htmlEl.style.setProperty(name, sanitizeCSSValue(String(getter())));
      });
      registerDisposer(el, teardown);
    } else {
      htmlEl.style.setProperty(name, sanitizeCSSValue(String(val)));
    }
  }
}

function applyClass(el: Element, cls: TagProps["class"]) {
  if (typeof cls === "string") {
    el.setAttribute("class", cls);
    return;
  }

  if (typeof cls === "function") {
    const teardown = track(() => {
      el.setAttribute("class", (cls as () => string)());
    });
    registerDisposer(el, teardown);
    return;
  }

  // Conditional object
  const obj = cls as Record<string, boolean | (() => boolean)>;
  let hasReactive = false;
  let result = "";
  for (const name in obj) {
    const val = obj[name];
    if (typeof val === "function") {
      hasReactive = true;
      break;
    }
    if (val) result = result ? `${result} ${name}` : name;
  }

  if (hasReactive) {
    const update = () => {
      let r = "";
      for (const name in obj) {
        const val = obj[name];
        const active = typeof val === "function" ? (val as () => boolean)() : val;
        if (active) r = r ? `${r} ${name}` : name;
      }
      el.setAttribute("class", r);
    };
    const teardown = track(update);
    registerDisposer(el, teardown);
  } else {
    el.setAttribute("class", result);
  }
}

// Append children — optimized for common cases, inlined to avoid function call overhead
function appendChildren(el: Element, nodes: NodeChildren) {
  // Fast path: single string → textContent (avoids createTextNode + appendChild)
  if (typeof nodes === "string") {
    el.textContent = nodes;
    return;
  }
  if (typeof nodes === "number") {
    el.textContent = String(nodes);
    return;
  }
  // Filter booleans (false from `condition && element` patterns, true is harmless)
  if (typeof nodes === "boolean" || nodes == null) {
    return;
  }
  if (typeof nodes === "function") {
    const ph = document.createComment("");
    el.appendChild(ph);
    registerDisposer(el, bindChildNode(ph, nodes as () => NodeChild));
    return;
  }
  if (nodes instanceof Node) {
    el.appendChild(nodes);
    return;
  }
  if (Array.isArray(nodes)) {
    for (let i = 0; i < nodes.length; i++) {
      const c = nodes[i];
      if (typeof c === "function") {
        const ph = document.createComment("");
        el.appendChild(ph);
        registerDisposer(el, bindChildNode(ph, c as () => NodeChild));
      } else if (c instanceof Node) {
        el.appendChild(c);
      } else if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) {
          const inner = (c as NodeChild[])[j];
          if (typeof inner === "function") {
            const ph = document.createComment("");
            el.appendChild(ph);
            registerDisposer(el, bindChildNode(ph, inner as () => NodeChild));
          } else if (inner instanceof Node) {
            el.appendChild(inner);
          } else if (inner != null && typeof inner !== "boolean") {
            el.appendChild(document.createTextNode(String(inner)));
          }
        }
      } else if (c != null && typeof c !== "boolean") {
        el.appendChild(document.createTextNode(String(c)));
      }
    }
  }
}

/**
 * Factory for creating HTML or SVG elements with reactive props and nodes.
 *
 * Calling conventions:
 *
 *   tag()                         empty element
 *   tag("text")                   element with text content
 *   tag(42)                       element with numeric text content
 *   tag([childA, childB])         element with children (array)
 *   tag(node)                     element wrapping a single existing node
 *   tag(getter)                   element with a reactive child
 *   tag("className", children)    positional: class + children
 *   tag({ ...props })             full props object (children via props.nodes)
 *   tag({ ...props }, children)   props + children (no need for `nodes:` key!)
 *
 * The last form is the "deeply-nested shorthand" the codebase favours:
 *
 *   div({ class: "card" }, [
 *     h1({ class: "title" }, "Hello"),
 *     p({ class: "body" }, "World"),
 *     div({ class: "row" }, [
 *       span({ id: "x" }, "child"),
 *     ]),
 *   ])
 *
 * `children` overrides `props.nodes` when both are present.
 */
export const tagFactory = (tag: string, ns?: string) => {
  return (first?: TagProps | NodeChildren, second?: NodeChildren): Element => {
    validateTagName(tag);
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);

    // Fast path: tag() — no arguments
    if (first === undefined) return el;

    // String first arg — either `tag("text")` or `tag("className", children)`
    if (typeof first === "string") {
      if (second !== undefined) {
        el.setAttribute("class", first);
        appendChildren(el, second);
        return el;
      }
      el.textContent = first;
      return el;
    }

    // Number first arg — treat as text content. This matches the
    // `appendChildren` number branch so `p(42)` works.
    if (typeof first === "number") {
      el.textContent = String(first);
      return el;
    }

    // Array / Node / function first arg — children-only shorthand
    // (`tag([children])`, `tag(existingNode)`, `tag(() => reactiveChild)`).
    // The second arg is ignored in these forms.
    if (Array.isArray(first) || first instanceof Node || typeof first === "function") {
      appendChildren(el, first as NodeChildren);
      return el;
    }

    // Full props object: tag({ class, on, style, ... }) OR
    //                    tag({ class, on, style, ... }, children)
    const props = first as TagProps;

    // Known-keys fast path: process common props via direct access,
    // then check if there are any custom attributes to iterate.
    const pClass = props.class;
    if (pClass != null) applyClass(el, pClass);

    const pId = props.id;
    if (pId != null) {
      // DOM clobbering: an element with id="foo" becomes window.foo. If the
      // id value is user-controlled, it can shadow globals like `config`,
      // `location`, etc. Warn in dev so authors notice.
      if (_isDev && typeof pId === "string" && CLOBBER_RISKY_IDS.has(pId.toLowerCase())) {
        devWarn(
          `tagFactory: element id="${pId}" matches a common global and may cause DOM clobbering. Avoid setting ids from untrusted input.`,
        );
      }
      el.id = pId as string;
    }

    // Children resolution: `second` (positional) beats `props.nodes`.
    // This lets callers write the deeply-nested shorthand:
    //   div({ class: "x" }, [ h1({ class: "t" }, "Hi") ])
    // instead of
    //   div({ class: "x", nodes: [ h1({ class: "t", nodes: "Hi" }) ] })
    const pNodes = second !== undefined ? second : props.nodes;
    if (pNodes != null) appendChildren(el, pNodes);

    const pOn = props.on;
    if (pOn) {
      for (const ev in pOn) {
        const handler = pOn[ev];
        if (typeof handler === "function") {
          el.addEventListener(ev, handler as EventListener);
        } else if (_isDev) {
          devWarn(
            `tagFactory: on.${ev} handler is not a function (got ${typeof handler}). Event listener was not attached.`,
          );
        }
      }
    }

    const pStyle = props.style;
    if (pStyle != null) applyStyle(el, pStyle);

    const pRef = props.ref;
    if (pRef) (pRef as { current: Element | null }).current = el;

    // Custom attributes — only enter the loop if there are keys beyond the known set
    for (const key in props) {
      switch (key) {
        case "class":
        case "id":
        case "nodes":
        case "on":
        case "style":
        case "ref":
        case "onElement":
          continue; // already handled above / below
        default: {
          const value = props[key];
          if (value == null) continue;
          // Block on* event-handler attributes (case-insensitive). The `on`
          // props object is the supported way to attach listeners.
          const lkey = key.toLowerCase();
          if (lkey[0] === "o" && lkey[1] === "n") continue;
          if (typeof value === "function") {
            registerDisposer(el, bindAttribute(el as HTMLElement, key, value as () => unknown));
          } else if (typeof value === "boolean") {
            // For IDL properties (checked, disabled, selected), set the DOM property directly
            if (key in el && (key === "checked" || key === "disabled" || key === "selected")) {
              setProp(el, key, value);
            } else if (value) {
              el.setAttribute(key, "");
            } else {
              el.removeAttribute(key);
            }
          } else {
            const str = String(value);
            if (lkey === "srcset") {
              el.setAttribute(key, sanitizeSrcset(str));
            } else if (isUrlAttribute(lkey)) {
              el.setAttribute(key, sanitizeUrl(str));
            } else {
              el.setAttribute(key, str);
            }
          }
        }
      }
    }

    // onElement callback — for imperative bindings (inputMask.bind, etc.)
    if (props.onElement && typeof props.onElement === "function") {
      (props.onElement as (el: HTMLElement) => void)(el as HTMLElement);
    }

    return el;
  };
};
