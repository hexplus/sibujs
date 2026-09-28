import { DEV, devWarn, devWarnLazy } from "../../core/dev";
import { bindAttribute } from "../../reactivity/bindAttribute";
import { bindChildNode } from "../../reactivity/bindChildNode";
import { reactiveBinding } from "../../reactivity/track";
import { isBlockedElement } from "../../utils/elementPolicy";
import { isEventHandlerAttr, sanitizeCSSDeclaration, sanitizeStyleAttribute } from "../../utils/sanitize";
import { setSafeAttribute } from "../../utils/setSafeAttribute";
import { registerDisposer } from "./dispose";
import type { NodeChild, NodeChildren } from "./types";

export const SVG_NS = "http://www.w3.org/2000/svg";

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

/**
 * A style declaration map: camelCase or kebab-case property names to values.
 * Each value may be a getter, which binds that one property reactively.
 */
export type StyleMap = Record<string, string | number | (() => string | number)>;

/**
 * A style map produced by a whole-`style` getter. The getter already runs
 * reactively, so its values are plain; a `null` / `undefined` value leaves the
 * property unset (and removes it if an earlier run set it).
 */
export type StyleObject = Record<string, string | number | null | undefined>;

/**
 * Listeners for the `on` prop. Known DOM event names get their specific event
 * type from the DOM lib (`keydown` → `KeyboardEvent`, `click` → the lib's
 * `MouseEvent` / `PointerEvent`), so a handler may declare it without a cast;
 * any other name (custom events) receives an `Event`. That fallback is
 * method-typed, so a handler declaring a narrower event
 * (`(e: CustomEvent<Detail>) => …`) is still accepted for a custom name.
 */
export type TagEventHandlers = {
  [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void;
} & {
  [event: string]: { handle(ev: Event): void }["handle"] | undefined;
};

/**
 * Props accepted by a tag factory. `El` is the element the factory creates;
 * it types `onElement`.
 */
export interface TagProps<El extends Element = HTMLElement> {
  id?: string | (() => string);
  class?: string | (() => string | null | undefined | false) | Record<string, boolean | (() => boolean)>;
  style?: StyleMap | string | (() => string | StyleObject);
  /**
   * Receives the created element. Accepts what `ref()` returns under `strict`
   * (`ref<HTMLInputElement>()` is a `Ref<HTMLInputElement | undefined>`) as
   * well as a `{ current: Element | null }` box.
   */
  ref?: { current: Element | null | undefined };
  nodes?: NodeChildren;
  on?: TagEventHandlers;
  /** Called with the element after creation — useful for imperative bindings */
  onElement?(el: El): void;
  [attr: string]: unknown;
}

/**
 * A tag factory: builds one `El` per call. See {@link tagFactory} for the
 * accepted calling conventions.
 */
export type TagFunction<El extends Element, Props extends TagProps<El> = TagProps<El>> = (
  first?: Props | NodeChildren,
  second?: NodeChildren,
) => El;

// Lone strings already warned about, so a list rendering the same mistaken
// class string for every row reports it ONCE instead of once per element.
// Keyed by tag + string. Dev-only: the only writer is inside a `devWarnLazy`
// callback, so in production this is an unreferenced empty Set.
const warnedLoneStrings = new Set<string>();
const MAX_WARNED_LONE_STRINGS = 100;
// Whether the "reporting has stopped" notice has already been printed. See the
// cap handling at the call site for why reaching the cap must SUPPRESS rather
// than merely stop remembering.
let loneStringCapAnnounced = false;

// Cache for camelCase → kebab-case conversions
const kebabCache = new Map<string, string>();

function toKebab(prop: string): string {
  let cached = kebabCache.get(prop);
  if (cached !== undefined) return cached;
  cached = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  kebabCache.set(prop, cached);
  return cached;
}

// Reactive class/style getters are DOM bindings, so they are registered with
// `reactiveBinding(commit, el)` rather than a bare `track(commit)`. Both create
// the same self-retracking subscriber — `track(commit)` delegates straight to
// `reactiveBinding(commit)` — but only the two-argument form stamps the owning
// node on it. Without that node, a getter that throws on a LATER scheduled run
// is reported from the drain with `node: undefined`, so `reportError` has no
// DOM position to dispatch from, no enclosing `ErrorBoundary` can be found, and
// the failure skips straight past the boundary to the global handler/console —
// unlike every other reactive attribute, which goes through `bindAttribute`.
//
// `track`'s second parameter is an explicit SUBSCRIBER, not an owner node, so
// it is not the right seam here.

function applyStyle(el: Element, style: TagProps["style"]) {
  // A whole style STRING is a declaration list and gets the same per-property
  // policy the object form below already applies. Writing it raw made the
  // string form a security escape hatch from the object form — identical
  // authoring intent with two different policies.
  //
  // A getter may return either form. The object form writes per property, so
  // it must remember what it wrote: a later run that no longer lists a
  // property removes it instead of leaving the old value behind.
  if (typeof style === "function") {
    const getter = style as () => string | StyleObject;
    let written: string[] = [];
    let wroteString = false;
    const teardown = reactiveBinding(() => {
      const value = getter();
      if (value === null || typeof value !== "object") {
        written = [];
        wroteString = true;
        el.setAttribute("style", sanitizeStyleAttribute(String(value), { element: el }));
        return;
      }
      const decl = (el as HTMLElement).style;
      // Switching from the string form: its declarations are not tracked
      // per property, so start from an empty list.
      if (wroteString) {
        el.removeAttribute("style");
        wroteString = false;
      }
      const next: string[] = [];
      for (const prop in value) {
        // Own keys only — see the attribute loop in `tagFactory`.
        if (!Object.hasOwn(value, prop)) continue;
        const val = value[prop];
        if (val == null) continue;
        const name = toKebab(prop);
        next.push(name);
        decl.setProperty(name, sanitizeCSSDeclaration(name, String(val), { element: el }));
      }
      for (let i = 0; i < written.length; i++) {
        if (next.indexOf(written[i]) === -1) decl.removeProperty(written[i]);
      }
      written = next;
    }, el);
    registerDisposer(el, teardown);
    return;
  }

  if (typeof style === "string") {
    el.setAttribute("style", sanitizeStyleAttribute(style, { element: el }));
    return;
  }

  const htmlEl = el as HTMLElement;
  for (const prop in style as StyleMap) {
    if (!Object.hasOwn(style as StyleMap, prop)) continue;
    const val = (style as StyleMap)[prop];
    const name = toKebab(prop);
    if (typeof val === "function") {
      const getter = val as () => string | number;
      const teardown = reactiveBinding(() => {
        htmlEl.style.setProperty(name, sanitizeCSSDeclaration(name, String(getter()), { element: el }));
      }, el);
      registerDisposer(el, teardown);
    } else {
      htmlEl.style.setProperty(name, sanitizeCSSDeclaration(name, String(val), { element: el }));
    }
  }
}

/**
 * Resolve any of the three `class` shapes a tag factory accepts — a string, a
 * getter, or a `{ name: boolean | getter }` map — down to one class string.
 *
 * Call it INSIDE a reactive context to get a reactive result: it reads the
 * getters it is given, so the enclosing effect subscribes to whatever they
 * touch. Exported so components that build their own elements (`RouterLink`)
 * honour exactly the shapes the tag factories do, instead of each re-deciding
 * which forms it supports — that drift is what made a reactive `class` render
 * as nothing on a `RouterLink` while working on every `div`.
 *
 * @param cls The `class` prop in any accepted shape.
 * @returns The resolved class string; `""` when the prop is absent.
 */
export function resolveClassValue(cls: TagProps["class"]): string {
  if (typeof cls === "string") return cls;
  if (typeof cls === "function") return cls() || "";
  if (!cls) return "";
  let out = "";
  for (const name in cls) {
    if (!Object.hasOwn(cls, name)) continue;
    const val = (cls as Record<string, boolean | (() => boolean)>)[name];
    const active = typeof val === "function" ? val() : val;
    if (active) out = out ? `${out} ${name}` : name;
  }
  return out;
}

function applyClass(el: Element, cls: TagProps["class"]) {
  if (typeof cls === "string") {
    el.setAttribute("class", cls);
    return;
  }

  if (typeof cls === "function") {
    // `null` / `undefined` / `false` mean "no class": the attribute is removed
    // rather than rendered as the literal text "undefined" / "false". That
    // lets a getter be written as `() => active() && "on"`.
    const teardown = reactiveBinding(() => {
      const value = cls();
      if (value == null || value === false) el.removeAttribute("class");
      else el.setAttribute("class", value);
    }, el);
    registerDisposer(el, teardown);
    return;
  }

  // Conditional object
  const obj = cls as Record<string, boolean | (() => boolean)>;
  let hasReactive = false;
  let result = "";
  for (const name in obj) {
    if (!Object.hasOwn(obj, name)) continue;
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
        if (!Object.hasOwn(obj, name)) continue;
        const val = obj[name];
        const active = typeof val === "function" ? (val as () => boolean)() : val;
        if (active) r = r ? `${r} ${name}` : name;
      }
      el.setAttribute("class", r);
    };
    const teardown = reactiveBinding(update, el);
    registerDisposer(el, teardown);
  } else {
    el.setAttribute("class", result);
  }
}

// Append children — optimized for common cases, inlined to avoid function call overhead.
// Exported so components that build their element by hand (`RouterLink`) accept
// exactly the children a tag factory does, getters included.
export function appendChildren(el: Element, nodes: NodeChildren) {
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
 *
 * The returned factory is typed by the tag: `tagFactory("div")` builds
 * `HTMLDivElement`s, `tagFactory("circle", SVG_NS)` builds `SVGCircleElement`s.
 * A tag name TypeScript does not know builds `HTMLElement`s (which is what
 * `document.createElement` returns for it), or `Element`s in another namespace.
 */
export function tagFactory<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ns?: undefined,
): TagFunction<HTMLElementTagNameMap[K]>;
export function tagFactory<K extends keyof SVGElementTagNameMap>(
  tag: K,
  ns: typeof SVG_NS,
): TagFunction<SVGElementTagNameMap[K]>;
export function tagFactory(tag: string, ns?: undefined): TagFunction<HTMLElement>;
export function tagFactory(tag: string, ns: typeof SVG_NS): TagFunction<SVGElement>;
export function tagFactory(tag: string, ns?: string): TagFunction<Element>;
export function tagFactory(tag: string, ns?: string): TagFunction<Element> {
  // Resolve the security blocklist ONCE per factory (the tag is constant) so
  // element creation pays only a boolean check instead of a `toLowerCase()` +
  // Set lookup per call. Creating a factory for a blocked tag (e.g. the
  // `script` export in html.ts) is still allowed; it throws only when called,
  // preserving the existing throw-on-use semantics.
  //
  // The list itself is the shared one in `utils/elementPolicy.ts` (script,
  // iframe, object, embed, frame, frameset — case-insensitive, any namespace,
  // since <script> exists in SVG too). A tag factory's name may be a runtime
  // value (`customElement(tagName)`), so it gets the runtime verdict.
  const blocked = isBlockedElement(tag);
  return (first?: TagProps<Element> | NodeChildren, second?: NodeChildren): Element => {
    if (blocked) {
      throw new Error(`tagFactory: refusing to create <${tag}> — tag is blocked for security reasons.`);
    }
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
      // Lone string → text child (unchanged). Warn in dev if it looks like a
      // misplaced class list, so a styled empty wrapper doesn't silently render
      // its class names as visible text.
      //
      // The heuristic, its de-duplication and its message all live INSIDE the
      // callback: a production build drops the closure whole, so none of this
      // reaches a consumer (see `devWarnLazy`). It costs one closure per
      // lone-string element creation in development, and nothing otherwise.
      devWarnLazy(() => {
        const tokens = first.trim().split(/\s+/);
        // TWO OR MORE tokens required, at least two of them utility-shaped.
        //
        // The earlier rule — any single token carrying a hyphen, colon, slash
        // or digit — measured 3.3% false positives on a corpus of prose, which
        // badly understated it: that corpus had no identifiers. Real
        // applications pass `item-0`, `home-content`, `user-42`, `v4.1.0`,
        // `src/index.ts`, `https://example.com` and `N/A` as ordinary text, and
        // every one of them tripped it. On a corpus including those the true
        // rate was 29.8%, and a list rendering `item-0`…`item-999` produced a
        // thousand warnings.
        //
        // Requiring two utility-shaped tokens takes measured false positives to
        // 0% (131 strings), because every one of those identifiers is a single
        // token, and hyphenated English ("state-of-the-art design", "read-only
        // field") carries only one. The cost is single-token class lists:
        // `div("space-y-6")` and `div("truncate")` no longer warn. That is a
        // deliberate trade — a warning developers learn to ignore protects
        // nobody, and the multi-token form is both the reported bug and the
        // dominant real-world shape.
        if (tokens.length < 2) return "";
        let utilityTokens = 0;
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          // Every token must be a plausible CSS class token.
          if (!/^-?[A-Za-z_][A-Za-z0-9_:/.-]*$/.test(tok)) return "";
          // A hyphen / colon / slash / digit marks a utility-class token
          // (h-6, md:flex, w-1/2). Plain words ("flex", "border") do not.
          if (/[-:/0-9]/.test(tok)) utilityTokens++;
        }
        if (utilityTokens < 2) return "";

        // One mistake reported once, however many elements repeat it.
        const key = `${tag}|${first}`;
        if (warnedLoneStrings.has(key)) return "";

        // Past the cap, STOP REPORTING — do not merely stop remembering.
        //
        // The cache previously kept returning the message while refusing to
        // insert new keys, which made `has(key)` permanently false for every
        // mistake after the hundredth. Those warned on every single render,
        // forever: the exact per-element flood this cache exists to prevent,
        // just postponed until a page was busy enough to hit the cap.
        //
        // Going quiet risks hiding a real mistake, so the silence announces
        // itself once. A developer who sees it knows to fix what has already
        // been reported and look again.
        if (warnedLoneStrings.size >= MAX_WARNED_LONE_STRINGS) {
          if (loneStringCapAnnounced) return "";
          loneStringCapAnnounced = true;
          return (
            `tagFactory: ${MAX_WARNED_LONE_STRINGS} distinct lone-string class warnings have been reported; ` +
            "suppressing further ones for the rest of this session so they cannot flood the console. " +
            "Fix the reported ones and reload to see any that remain."
          );
        }
        warnedLoneStrings.add(key);

        return (
          `tagFactory: lone string "${first}" looks like a class list but is being rendered as TEXT. ` +
          `For a class, use ${tag}({ class: "${first}" }) — or ${tag}("${first}", children) to set the class AND add children.`
        );
      });
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
    const props = first as TagProps<Element>;

    // Known-keys fast path: process common props via direct access,
    // then check if there are any custom attributes to iterate.
    const pClass = props.class;
    if (pClass != null) applyClass(el, pClass);

    const pId = props.id;
    if (typeof pId === "function") {
      // Reactive id — bound like any other reactive attribute (the same path
      // the `html` template takes). Assigning the getter to `el.id` directly
      // stringified it, rendering the function's own source as the id.
      registerDisposer(el, bindAttribute(el as HTMLElement, "id", pId));
    } else if (pId != null) {
      // DOM clobbering: an element with id="foo" becomes window.foo. If the
      // id value is user-controlled, it can shadow globals like `config`,
      // `location`, etc. Warn in dev so authors notice.
      if (DEV && typeof pId === "string" && CLOBBER_RISKY_IDS.has(pId.toLowerCase())) {
        devWarn(
          `tagFactory: element id="${pId}" matches a common global and may cause DOM clobbering. Avoid setting ids from untrusted input.`,
        );
      }
      el.id = pId;
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
        if (!Object.hasOwn(pOn, ev)) continue;
        const handler: unknown = pOn[ev];
        if (typeof handler === "function") {
          el.addEventListener(ev, handler as EventListener);
        } else if (DEV) {
          devWarn(
            `tagFactory: on.${ev} handler is not a function (got ${typeof handler}). Event listener was not attached.`,
          );
        }
      }
    }

    const pStyle = props.style;
    if (pStyle != null) applyStyle(el, pStyle);

    const pRef = props.ref;
    if (pRef) pRef.current = el;

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
          // OWN keys only. `for…in` also walks inherited enumerable keys, so a
          // polluted `Object.prototype` (from some other library's unsafe
          // merge) would otherwise stamp its keys as attributes on EVERY
          // element the framework creates — `formaction`, `target`, ARIA
          // text. The attribute policy still filters the values, but which
          // attributes an element carries is not the prototype's to decide.
          if (!Object.hasOwn(props, key)) continue;
          const value = props[key];
          if (value == null) continue;
          // Block on* event-handler attributes (shared guard). The `on` props
          // object is the supported way to attach listeners.
          if (isEventHandlerAttr(key)) continue;
          if (typeof value === "function") {
            registerDisposer(el, bindAttribute(el as HTMLElement, key, value as () => unknown));
          } else {
            // Shared commit primitive — same policy as the reactive
            // bindAttribute path and as bindAttrs/svgElement.
            //
            // `syncValueProperty: false` preserves this path's deliberate
            // difference from a live update: on FIRST render the content
            // attribute is the correct sink for `value`, since it seeds the
            // control's default and survives a form reset. A reactive update
            // must use the IDL property instead, because after the user types
            // the content attribute no longer reflects the current state.
            setSafeAttribute(el, key, value, { syncValueProperty: false, label: "tagFactory" });
          }
        }
      }
    }

    // onElement callback — for imperative bindings (inputMask.bind, etc.)
    if (typeof props.onElement === "function") props.onElement(el);

    return el;
  };
}
