import { devWarn, isDev } from "../../core/dev";
import { bindAttribute } from "../../reactivity/bindAttribute";
import { bindChildNode } from "../../reactivity/bindChildNode";
import { isUrlAttribute, sanitizeSrcset, sanitizeUrl } from "../../utils/sanitize";
import { registerDisposer } from "./dispose";
import { SVG_NS } from "./tagFactory";
import type { NodeChild } from "./types";

const _isDev = isDev();

// Tags whose children are treated as raw text by the HTML parser and thus
// cannot safely embed dynamic expressions.
const RAW_TEXT_TAGS = new Set(["script", "style"]);

// Void elements that cannot have children (self-closing by spec)
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// SVG tag names — created with SVG namespace for correct rendering
const SVG_TAGS = new Set([
  "svg",
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
  "symbol",
  "marker",
]);

// ── Cached template tree types ──────────────────────────────────────────────

/** Attribute in a cached template — stores structure, not values */
type TmplAttr =
  | { t: 0 /* static */; name: string; value: string }
  | { t: 1 /* expr */; name: string; idx: number }
  | { t: 2 /* mixed */; name: string; statics: string[]; exprs: number[] }
  | { t: 3 /* event */; name: string; idx: number }
  | { t: 4 /* boolean */; name: string };

/** Child in a cached template */
type TmplChild =
  | { t: 0 /* element */; el: TmplElement }
  | { t: 1 /* text */; value: string }
  | { t: 2 /* expr */; idx: number };

interface TmplElement {
  tag: string;
  svg: boolean;
  attrs: TmplAttr[];
  children: TmplChild[];
}

// ── Template cache (WeakMap keyed by strings array identity) ────────────────

const cache = new WeakMap<TemplateStringsArray, TmplChild[]>();

// ── Parse phase: runs once per call site ────────────────────────────────────

function parseTemplate(strings: TemplateStringsArray): TmplChild[] {
  // Build template with expression markers: \x00<index>\x00
  const exprCount = strings.length - 1;
  let template = strings[0];
  for (let i = 0; i < exprCount; i++) {
    template += `\x00${i}\x00${strings[i + 1]}`;
  }

  let pos = 0;
  const len = template.length;

  // --- Helpers ---

  function skipWs(): void {
    while (
      pos < len &&
      (template[pos] === " " || template[pos] === "\t" || template[pos] === "\n" || template[pos] === "\r")
    )
      pos++;
  }

  /** Try to read an expression marker \x00<index>\x00. Returns expr index or -1. */
  function tryExprIdx(): number {
    if (template.charCodeAt(pos) !== 0) return -1;
    const start = pos;
    pos++;
    // Parse integer directly from chars — avoids string allocation
    let idx = 0;
    while (pos < len && template.charCodeAt(pos) !== 0) {
      idx = idx * 10 + (template.charCodeAt(pos) - 48);
      pos++;
    }
    if (pos < len) pos++; // skip closing \x00
    if (idx < 0 || idx >= exprCount) {
      pos = start;
      return -1;
    }
    return idx;
  }

  function readTagName(): string {
    const start = pos;
    while (pos < len) {
      const c = template.charCodeAt(pos);
      // a-z: 97-122, A-Z: 65-90, 0-9: 48-57, -: 45
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) {
        pos++;
      } else break;
    }
    return template.slice(start, pos);
  }

  function parseAttrValue(): TmplAttr["t"] extends number
    ?
        | { kind: "static"; value: string }
        | { kind: "expr"; idx: number }
        | { kind: "mixed"; statics: string[]; exprs: number[] }
        | { kind: "bool" }
    : never {
    skipWs();
    if (template[pos] !== "=") return { kind: "bool" } as any;

    pos++; // skip =
    skipWs();

    // Expression value: attr=${expr}
    const exprIdx = tryExprIdx();
    if (exprIdx >= 0) return { kind: "expr", idx: exprIdx } as any;

    // Quoted value: attr="..." or attr='...'
    const quote = template[pos];
    if (quote === '"' || quote === "'") {
      pos++; // skip opening quote
      const statics: string[] = [];
      const exprs: number[] = [];
      let current = "";

      while (pos < len && template[pos] !== quote) {
        const innerIdx = tryExprIdx();
        if (innerIdx >= 0) {
          statics.push(current);
          current = "";
          exprs.push(innerIdx);
        } else {
          current += template[pos++];
        }
      }
      if (pos < len) pos++; // skip closing quote
      statics.push(current);

      if (exprs.length === 0) {
        // Purely static quoted value
        return { kind: "static", value: statics[0] } as any;
      }
      return { kind: "mixed", statics, exprs } as any;
    }

    // Unquoted value: read until whitespace or > or /
    const valStart = pos;
    while (pos < len) {
      const c = template.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 47) break; // space/tab/nl/cr/>/
      pos++;
    }
    const val = template.slice(valStart, pos);
    return { kind: "static", value: val } as any;
  }

  function parseAttrs(): TmplAttr[] {
    const attrs: TmplAttr[] = [];

    while (pos < len) {
      skipWs();
      if (template[pos] === ">" || template[pos] === "/") break;

      const attrStart = pos;
      while (pos < len) {
        const c = template.charCodeAt(pos);
        // a-z: 97-122, A-Z: 65-90, 0-9: 48-57, -: 45, :: 58, _: 95, .: 46
        if (
          (c >= 97 && c <= 122) ||
          (c >= 65 && c <= 90) ||
          (c >= 48 && c <= 57) ||
          c === 45 ||
          c === 58 ||
          c === 95 ||
          c === 46
        ) {
          pos++;
        } else break;
      }
      const attrName = template.slice(attrStart, pos);
      if (!attrName) break;

      const val = parseAttrValue() as any;

      if (attrName.startsWith("on:")) {
        // Event handler — must be an expression
        if (val.kind === "expr") {
          attrs.push({ t: 3, name: attrName.slice(3), idx: val.idx });
        }
      } else if (val.kind === "bool") {
        attrs.push({ t: 4, name: attrName });
      } else if (val.kind === "static") {
        attrs.push({ t: 0, name: attrName, value: val.value });
      } else if (val.kind === "expr") {
        attrs.push({ t: 1, name: attrName, idx: val.idx });
      } else if (val.kind === "mixed") {
        attrs.push({ t: 2, name: attrName, statics: val.statics, exprs: val.exprs });
      }
    }

    return attrs;
  }

  /** Collapse whitespace runs to a single space, matching HTML whitespace rules. */
  function collapseWs(s: string): string {
    return s.replace(/\s+/g, " ");
  }

  function parseTextChildren(children: TmplChild[]): void {
    let text = "";
    while (pos < len && template[pos] !== "<") {
      const idx = tryExprIdx();
      if (idx >= 0) {
        // Collapse whitespace like HTML: runs of whitespace become a single space
        const collapsed = collapseWs(text);
        if (collapsed) children.push({ t: 1, value: collapsed });
        text = "";
        children.push({ t: 2, idx });
      } else {
        text += template[pos++];
      }
    }
    const collapsed = collapseWs(text);
    if (collapsed) children.push({ t: 1, value: collapsed });
  }

  function parseChildren(): TmplChild[] {
    const children: TmplChild[] = [];

    while (pos < len) {
      if (template[pos] === "<" && pos + 1 < len && template[pos + 1] === "/") break;

      if (template[pos] === "<") {
        pos++; // skip <
        const tag = readTagName();
        const attrs = parseAttrs();
        skipWs();

        const isVoid = VOID_ELEMENTS.has(tag);
        const isSelfClosing = template[pos] === "/";
        if (isSelfClosing) pos++;
        if (pos < len) pos++; // skip >

        if (isVoid || isSelfClosing) {
          children.push({ t: 0, el: { tag, svg: SVG_TAGS.has(tag), attrs, children: [] } });
        } else {
          const inner = parseChildren();

          // Raw-text contexts (<script>, <style>) cannot safely interpolate
          // dynamic values — the HTML parser treats their contents as raw
          // text, so escaping doesn't apply. Refuse at parse time.
          if (RAW_TEXT_TAGS.has(tag.toLowerCase())) {
            for (let i = 0; i < inner.length; i++) {
              if (inner[i].t === 2) {
                throw new Error(
                  `html: dynamic \${...} expressions are not allowed inside <${tag}> (raw-text context). Build the content separately and append it as a Node.`,
                );
              }
            }
          }

          // Skip closing tag </tagName>
          if (template[pos] === "<" && pos + 1 < len && template[pos + 1] === "/") {
            pos += 2;
            readTagName();
            skipWs();
            if (pos < len && template[pos] === ">") pos++;
          }

          children.push({ t: 0, el: { tag, svg: SVG_TAGS.has(tag), attrs, children: inner } });
        }
      } else {
        parseTextChildren(children);
      }
    }

    return children;
  }

  return parseChildren();
}

// ── Execute phase: replays cached tree with fresh values ────────────────────

function executeElement(tmpl: TmplElement, values: unknown[]): Element {
  // Create element directly — avoids allocating a props object + passing through tagFactory
  const el = tmpl.svg ? document.createElementNS(SVG_NS, tmpl.tag) : document.createElement(tmpl.tag);

  // Replay attributes directly on the element
  for (let i = 0; i < tmpl.attrs.length; i++) {
    const attr = tmpl.attrs[i];
    switch (attr.t) {
      case 0: // static
        el.setAttribute(attr.name, attr.value);
        break;
      case 1: {
        // expr
        const name = attr.name;
        // Block on* event handler attributes (XSS prevention) — case-insensitive
        const lname = name.toLowerCase();
        if (lname[0] === "o" && lname[1] === "n") break;
        const val = values[attr.idx];
        if (typeof val === "function") {
          registerDisposer(el, bindAttribute(el as HTMLElement, name, val as () => unknown));
        } else if (val != null) {
          const str = String(val);
          if (lname === "srcset") {
            el.setAttribute(name, sanitizeSrcset(str));
          } else if (isUrlAttribute(lname)) {
            el.setAttribute(name, sanitizeUrl(str));
          } else {
            el.setAttribute(name, str);
          }
        }
        break;
      }
      case 2: {
        // mixed — concatenate statics + expressions, then sanitize the whole
        // string for URL attributes so attacks like `href="java${x}:..."`
        // still get caught.
        let val = attr.statics[0];
        for (let j = 0; j < attr.exprs.length; j++) {
          const ev = values[attr.exprs[j]];
          val += (ev == null ? "" : String(ev)) + attr.statics[j + 1];
        }
        const lname2 = attr.name.toLowerCase();
        if (lname2 === "srcset") {
          el.setAttribute(attr.name, sanitizeSrcset(val));
        } else if (isUrlAttribute(lname2)) {
          el.setAttribute(attr.name, sanitizeUrl(val));
        } else {
          el.setAttribute(attr.name, val);
        }
        break;
      }
      case 3: {
        // event — must be a function
        const fn = values[attr.idx];
        if (typeof fn === "function") {
          el.addEventListener(attr.name, fn as EventListener);
        } else if (_isDev) {
          devWarn(
            `html: on:${attr.name} handler is not a function (got ${typeof fn}). Event listener was not attached.`,
          );
        }
        break;
      }
      case 4: // boolean
        el.setAttribute(attr.name, "");
        break;
    }
  }

  // Replay children directly
  for (let i = 0; i < tmpl.children.length; i++) {
    const child = tmpl.children[i];
    switch (child.t) {
      case 0: // element
        el.appendChild(executeElement(child.el, values));
        break;
      case 1: // static text
        el.appendChild(document.createTextNode(child.value));
        break;
      case 2: {
        // expression
        const val = values[child.idx];
        if (typeof val === "function") {
          const ph = document.createComment("");
          el.appendChild(ph);
          registerDisposer(el, bindChildNode(ph, val as () => NodeChild));
        } else if (val instanceof Node) {
          el.appendChild(val);
        } else if (Array.isArray(val)) {
          for (let j = 0; j < val.length; j++) {
            const item = val[j];
            if (item instanceof Node) {
              el.appendChild(item);
            } else if (item != null && typeof item !== "boolean") {
              el.appendChild(document.createTextNode(String(item)));
            }
          }
        } else if (val != null && typeof val !== "boolean") {
          el.appendChild(document.createTextNode(String(val)));
        }
        break;
      }
    }
  }

  return el;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Tagged template literal for building Sibu elements with HTML-like syntax.
 * Runtime-only — no compiler or build step required.
 *
 * Templates are parsed once per call site and cached. Subsequent calls at the
 * same source location skip parsing entirely and only replay the cached
 * structure with fresh expression values.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Element {
  let tmpl = cache.get(strings);
  if (!tmpl) {
    tmpl = parseTemplate(strings);
    cache.set(strings, tmpl);
  }

  // Fast path: single root element (most common case)
  if (tmpl.length === 1 && tmpl[0].t === 0) {
    return executeElement(tmpl[0].el, values);
  }

  // Multiple roots or non-element root — build wrapper inline (no intermediate array)
  const wrapper = document.createElement("div");
  for (let i = 0; i < tmpl.length; i++) {
    const child = tmpl[i];
    switch (child.t) {
      case 0:
        wrapper.appendChild(executeElement(child.el, values));
        break;
      case 1:
        wrapper.appendChild(document.createTextNode(child.value));
        break;
      case 2: {
        const val = values[child.idx];
        if (val instanceof Node) {
          wrapper.appendChild(val);
        } else if (typeof val === "function") {
          const ph = document.createComment("bind:htm");
          wrapper.appendChild(ph);
          registerDisposer(wrapper, bindChildNode(ph, val as () => NodeChild));
        } else if (Array.isArray(val)) {
          for (let j = 0; j < val.length; j++) {
            const item = val[j];
            if (item instanceof Node) {
              wrapper.appendChild(item);
            } else if (item != null && typeof item !== "boolean") {
              wrapper.appendChild(document.createTextNode(String(item)));
            }
          }
        } else if (val != null && typeof val !== "boolean") {
          wrapper.appendChild(document.createTextNode(String(val)));
        }
        break;
      }
    }
  }
  // If the wrapper ended up with a single element child, unwrap it
  if (wrapper.childNodes.length === 1 && wrapper.firstChild instanceof Element) {
    return wrapper.firstChild;
  }
  return wrapper;
}
