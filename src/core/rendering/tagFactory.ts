import { bindAttribute } from "../../reactivity/bindAttribute";
import { bindChildNode } from "../../reactivity/bindChildNode";
import { track } from "../../reactivity/track";
import { isUrlAttribute, sanitizeCSSValue, sanitizeUrl } from "../../utils/sanitize";
import { registerDisposer } from "./dispose";
import type { NodeChild, NodeChildren } from "./types";

export const SVG_NS = "http://www.w3.org/2000/svg";

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
 */
export const tagFactory =
  (tag: string, ns?: string) =>
  (first?: TagProps | NodeChildren, second?: NodeChildren): Element => {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);

    // Fast path: tag() — no arguments
    if (first === undefined) return el;

    // Fast path: tag("text") — single string, no second arg
    if (second === undefined && typeof first === "string") {
      el.textContent = first;
      return el;
    }

    // Fast path: tag("className", nodes) — shorthand
    if (second !== undefined) {
      el.setAttribute("class", first as string);
      appendChildren(el, second);
      return el;
    }

    // Fast path: tag([children]) or tag(node)
    if (Array.isArray(first) || first instanceof Node) {
      appendChildren(el, first as NodeChildren);
      return el;
    }

    // Full props object: tag({ class, nodes, on, ... })
    const props = first as TagProps;

    // Known-keys fast path: process common props via direct access,
    // then check if there are any custom attributes to iterate.
    const pClass = props.class;
    if (pClass != null) applyClass(el, pClass);

    const pId = props.id;
    if (pId != null) el.id = pId as string;

    const pNodes = props.nodes;
    if (pNodes != null) appendChildren(el, pNodes);

    const pOn = props.on;
    if (pOn) {
      for (const ev in pOn) {
        el.addEventListener(ev, pOn[ev] as EventListener);
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
          if (key[0] === "o" && key[1] === "n") continue;
          if (typeof value === "function") {
            registerDisposer(el, bindAttribute(el as HTMLElement, key, value as () => unknown));
          } else if (typeof value === "boolean") {
            // For IDL properties (checked, disabled, selected), set the DOM property directly
            if (key in el && (key === "checked" || key === "disabled" || key === "selected")) {
              (el as unknown as Record<string, boolean>)[key] = value;
            } else if (value) {
              el.setAttribute(key, "");
            } else {
              el.removeAttribute(key);
            }
          } else {
            const str = String(value);
            el.setAttribute(key, isUrlAttribute(key) ? sanitizeUrl(str) : str);
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
