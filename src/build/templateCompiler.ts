/**
 * Build-time compiler for SibuJS html tagged templates — the implementation
 * behind `compileHtmlTemplates` (compileTemplates.ts) and the Vite plugin's
 * `compileTemplates` option. Internal; not re-exported from `sibujs/build`.
 *
 * Transforms:
 *   html`<div class=${cls}><span>${() => count()}</span></div>`
 *
 * Into a module-level construction function plus a call that passes the
 * template's expressions in their original order:
 *
 *   __sibujs$t0((cls), (() => count()))
 *   ...
 *   function __sibujs$t0(v0, v1) {
 *     const e0 = document.createElement("div");
 *     __sibujs$attr(e0, "class", v0);
 *     const e1 = document.createElement("span");
 *     __sibujs$child(e1, v1);
 *     e0.appendChild(e1);
 *     return e0;
 *   }
 *
 * THE CONTRACT: IDENTICAL OUTPUT OR NO COMPILATION
 * ------------------------------------------------
 * The runtime `html` tag (src/core/rendering/htm.ts) is the reference. A
 * compiled template must build exactly the DOM the runtime would — same
 * elements, namespaces, attribute order and values, text nodes, placeholders,
 * and the same security policy for runtime values. Whenever the compiler
 * cannot guarantee that, it leaves the template untouched and the runtime
 * parser handles it. A slower template is a performance note; a different one
 * is a production-only bug that no development build can reproduce, which is
 * exactly how the previous compiler shipped broken bundles.
 *
 * That is why the generated code does NOT go through the tag factories. They
 * have their own semantics (blocked tags, the `class`/`style`/`id`/`ref`/`on`/
 * `nodes`/`onElement` props, sanitized static attributes, a fixed attribute
 * order) and the runtime parser deliberately does not. Instead the parser
 * below is a line-for-line port of the runtime's, and the emitted code replays
 * the runtime's execute phase step by step:
 *
 *   - static / boolean attribute   → `setAttribute`, as the runtime does (its
 *     `setTrustedAttribute` refuses only `srcdoc` and the contextual element
 *     policy, which cannot refuse a static write outside `<meta>` and `<link>`
 *     — all three are left to the runtime)
 *   - expression / mixed attribute → `bindAttrs` (sibujs/ui), which commits
 *     through the same `bindAttribute` / `setSafeAttribute` primitives
 *   - `on:event=${fn}`             → `addEventListener` when it is a function,
 *     and the runtime's development warning when it is not
 *   - function child               → `Fragment([fn])`, the same `""` comment
 *     placeholder + `bindChildNode` the runtime creates, with its cleanup
 *     registered on the ELEMENT as the runtime registers it — so
 *     `disposeNodeOwn(el)` releases it, not only a full `dispose(el)`
 *
 * Templates the straight-line code cannot reproduce exactly are STILL compiled,
 * into a call to `__renderParsedTemplate(tree, values)`: the runtime's own
 * executor, handed the tree this module already parsed. Parsing moves to build
 * time and the output is the runtime's by construction. That covers:
 *   - an expression or mixed value on `value` / `checked` (the runtime commits
 *     it with `syncValueProperty: false`, which no public primitive exposes),
 *   - a top-level `${expr}` (its runtime placeholder is `<!--bind:htm-->`,
 *     owned by the wrapper),
 *   - any `<meta>` element (the runtime judges its static attributes against
 *     the meta-refresh policy; a plain `setAttribute` cannot),
 *   - any `<link>` element (the stylesheet rule refuses a static `rel` that
 *     would apply a runtime-chosen `href`),
 *   - a static `srcdoc` attribute (the runtime refuses it on every path),
 *   - quasis with an escape that has no cooked value (the runtime receives
 *     `undefined` and reads it as the text "undefined").
 *
 * `${expr}` inside `<script>` / `<style>` compiles to a function that throws
 * the runtime's own error on every call, exactly when and as often as the
 * runtime throws it. The one template left to the runtime is a lone quasi with
 * no cooked value (`html\`\u{\``): the runtime fails on it with an engine
 * `TypeError` whose text the compiler cannot reproduce.
 *
 * Only templates tagged by an `html` binding IMPORTED FROM SIBUJS are
 * compiled. `foo.html\`\``, a local `html` helper, or any file that also uses
 * the imported name in a way that could shadow it are left alone.
 *
 * The development-only warning for a non-function `on:event` handler is
 * emitted by compiled code too, guarded by the same `__SIBU_DEV__` define the
 * Vite and webpack plugins set, so it folds out of production builds.
 */

import { jsStringLiteral, lineBreaksIn, type SourceEdit } from "./sourceEdit";
import { bindingUses, cookEscapes, isSibuSource, scanModule, type Token, uniquePrefix } from "./sourceScan";

// ── Runtime-parser port (keep in lockstep with src/core/rendering/htm.ts) ────

const RAW_TEXT_TAGS = new Set(["script", "style"]);

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

const SVG_NS = "http://www.w3.org/2000/svg";

type TmplAttr =
  | { t: 0; name: string; value: string }
  | { t: 1; name: string; idx: number }
  | { t: 2; name: string; statics: string[]; exprs: number[] }
  | { t: 3; name: string; idx: number }
  | { t: 4; name: string };

type TmplChild = { t: 0; el: TmplElement } | { t: 1; value: string } | { t: 2; idx: number };

interface TmplElement {
  tag: string;
  svg: boolean;
  attrs: TmplAttr[];
  children: TmplChild[];
}

/** Thrown where the runtime parser would throw; the template is left uncompiled. */
class RuntimeParseError extends Error {}

type AttrValue =
  | { kind: "static"; value: string }
  | { kind: "expr"; idx: number }
  | { kind: "mixed"; statics: string[]; exprs: number[] }
  | { kind: "bool" };

/**
 * Parse the COOKED template strings into the same tree the runtime builds.
 * Every branch mirrors `parseTemplate` in htm.ts; divergence here is a parity
 * bug, and the execution-parity tests exist to catch it.
 */
function parseTemplate(strings: readonly string[]): TmplChild[] {
  const exprCount = strings.length - 1;
  let template = strings[0];
  for (let i = 0; i < exprCount; i++) {
    template += `\x00${i}\x00${strings[i + 1]}`;
  }

  let pos = 0;
  const len = template.length;

  function skipWs(): void {
    while (
      pos < len &&
      (template[pos] === " " || template[pos] === "\t" || template[pos] === "\n" || template[pos] === "\r")
    )
      pos++;
  }

  function tryExprIdx(): number {
    if (template.charCodeAt(pos) !== 0) return -1;
    const start = pos;
    pos++;
    let idx = 0;
    while (pos < len && template.charCodeAt(pos) !== 0) {
      idx = idx * 10 + (template.charCodeAt(pos) - 48);
      pos++;
    }
    if (pos < len) pos++;
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
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) {
        pos++;
      } else break;
    }
    return template.slice(start, pos);
  }

  function parseAttrValue(): AttrValue {
    skipWs();
    if (template[pos] !== "=") return { kind: "bool" };
    pos++;
    skipWs();

    const exprIdx = tryExprIdx();
    if (exprIdx >= 0) return { kind: "expr", idx: exprIdx };

    const quote = template[pos];
    if (quote === '"' || quote === "'") {
      pos++;
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
      if (pos < len) pos++;
      statics.push(current);
      if (exprs.length === 0) return { kind: "static", value: statics[0] };
      return { kind: "mixed", statics, exprs };
    }

    // Unquoted: terminated by whitespace or `>` only — `/` is part of the
    // value (`href=/about`), and expression markers may be embedded.
    const statics: string[] = [];
    const exprs: number[] = [];
    let current = "";
    while (pos < len) {
      const c = template.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62) break;
      const innerIdx = tryExprIdx();
      if (innerIdx >= 0) {
        statics.push(current);
        current = "";
        exprs.push(innerIdx);
      } else {
        current += template[pos++];
      }
    }
    statics.push(current);
    if (exprs.length === 0) return { kind: "static", value: statics[0] };
    return { kind: "mixed", statics, exprs };
  }

  function parseAttrs(): TmplAttr[] {
    const attrs: TmplAttr[] = [];
    while (pos < len) {
      skipWs();
      if (template[pos] === ">" || template[pos] === "/") break;
      const attrStart = pos;
      while (pos < len) {
        const c = template.charCodeAt(pos);
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

      const val = parseAttrValue();
      if (attrName.startsWith("on:")) {
        if (val.kind === "expr") attrs.push({ t: 3, name: attrName.slice(3), idx: val.idx });
      } else if (val.kind === "bool") {
        attrs.push({ t: 4, name: attrName });
      } else if (val.kind === "static") {
        attrs.push({ t: 0, name: attrName, value: val.value });
      } else if (val.kind === "expr") {
        attrs.push({ t: 1, name: attrName, idx: val.idx });
      } else {
        attrs.push({ t: 2, name: attrName, statics: val.statics, exprs: val.exprs });
      }
    }
    return attrs;
  }

  function collapseWs(s: string): string {
    return s.replace(/\s+/g, " ");
  }

  function parseTextChildren(children: TmplChild[]): void {
    let text = "";
    while (pos < len && template[pos] !== "<") {
      const idx = tryExprIdx();
      if (idx >= 0) {
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
        const next = template[pos + 1];
        if (next === "!") {
          if (template.startsWith("<!--", pos)) {
            const end = template.indexOf("-->", pos + 4);
            pos = end === -1 ? len : end + 3;
          } else if (template.startsWith("<![CDATA[", pos)) {
            const end = template.indexOf("]]>", pos + 9);
            pos = end === -1 ? len : end + 3;
          } else {
            const end = template.indexOf(">", pos);
            pos = end === -1 ? len : end + 1;
          }
          continue;
        }
        if (next === "?") {
          const end = template.indexOf(">", pos);
          pos = end === -1 ? len : end + 1;
          continue;
        }
        if (!(next >= "a" && next <= "z") && !(next >= "A" && next <= "Z")) {
          children.push({ t: 1, value: "<" });
          pos++;
          continue;
        }

        pos++;
        const tag = readTagName();
        const attrs = parseAttrs();
        skipWs();

        const isVoid = VOID_ELEMENTS.has(tag);
        const isSelfClosing = template[pos] === "/";
        if (isSelfClosing) pos++;
        if (pos < len) pos++;

        if (isVoid || isSelfClosing) {
          children.push({ t: 0, el: { tag, svg: SVG_TAGS.has(tag), attrs, children: [] } });
        } else {
          const inner = parseChildren();
          if (RAW_TEXT_TAGS.has(tag.toLowerCase()) && inner.some((c) => c.t === 2)) {
            throw new RuntimeParseError(tag);
          }
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

// ── Code generation ──────────────────────────────────────────────────────────

/** Attributes whose runtime expression commit uses `syncValueProperty: false`. */
const IDL_SYNCED_ATTRS = new Set(["value", "checked"]);

interface Helpers {
  prefix: string;
  used: Set<"attr" | "str" | "on" | "child" | "run">;
  tags: Set<string>;
  svg: boolean;
}

/**
 * Generate straight-line DOM code for a construction function, or `null` when
 * that code cannot reproduce the runtime exactly (reasons documented at each
 * `return null`). A `null` template is then compiled through the runtime's own
 * executor instead — see `__renderParsedTemplate`.
 */
function generateBody(roots: TmplChild[], h: Helpers): string | null {
  const lines: string[] = [];
  let n = 0;
  const q = jsStringLiteral;
  const P = h.prefix;

  function genElement(el: TmplElement): string | null {
    // A `<meta>` carries a contextual rule (the meta-refresh policy) that the
    // runtime applies to its STATIC attributes too, judged against the whole
    // element — `<meta content=${x} http-equiv="refresh">` is refused at the
    // static write. The emitted `setAttribute` cannot reproduce that verdict,
    // so these templates go through the runtime executor.
    // A `<link>` likewise: the stylesheet rule refuses a STATIC `rel` that
    // would apply a runtime-chosen `href` (`<link href=${url} rel="stylesheet">`
    // writes the runtime `href` first), and the emitted `setAttribute` would
    // turn that `rel` on.
    const tag = el.tag.toLowerCase();
    if (tag === "meta" || tag === "link") return null;
    // Likewise a STATIC `srcdoc` (any casing): the runtime refuses it on every
    // path, and the emitted `setAttribute` would write it.
    for (const attr of el.attrs) {
      if ((attr.t === 0 || attr.t === 4) && attr.name.toLowerCase() === "srcdoc") return null;
    }
    const v = `e${n++}`;
    h.tags.add(el.tag);
    if (el.svg) h.svg = true;
    lines.push(
      el.svg
        ? `const ${v} = document.createElementNS(${q(SVG_NS)}, ${q(el.tag)});`
        : `const ${v} = document.createElement(${q(el.tag)});`,
    );
    for (const attr of el.attrs) {
      switch (attr.t) {
        case 0:
          lines.push(`${v}.setAttribute(${q(attr.name)}, ${q(attr.value)});`);
          break;
        case 4:
          lines.push(`${v}.setAttribute(${q(attr.name)}, "");`);
          break;
        case 1:
        case 2: {
          // The runtime commits a non-function value here with
          // `syncValueProperty: false` (content attribute, not the IDL
          // property). `bindAttrs` uses the IDL property for `value`/`checked`,
          // so for those two names the results differ — runtime executor.
          if (IDL_SYNCED_ATTRS.has(attr.name.toLowerCase())) return null;
          h.used.add("attr");
          if (attr.t === 1) {
            lines.push(`${P}attr(${v}, ${q(attr.name)}, v${attr.idx});`);
          } else {
            h.used.add("str");
            let expr = q(attr.statics[0]);
            for (let j = 0; j < attr.exprs.length; j++) {
              expr += ` + ${P}str(v${attr.exprs[j]}) + ${q(attr.statics[j + 1])}`;
            }
            lines.push(`${P}attr(${v}, ${q(attr.name)}, ${expr});`);
          }
          break;
        }
        case 3:
          h.used.add("on");
          lines.push(`${P}on(${v}, ${q(attr.name)}, v${attr.idx});`);
          break;
      }
    }
    for (const child of el.children) {
      if (child.t === 0) {
        const c = genElement(child.el);
        if (c === null) return null;
        lines.push(`${v}.appendChild(${c});`);
      } else if (child.t === 1) {
        lines.push(`${v}.appendChild(document.createTextNode(${q(child.value)}));`);
      } else {
        h.used.add("child");
        lines.push(`${P}child(${v}, v${child.idx});`);
      }
    }
    return v;
  }

  // Runtime fast path: exactly one root and it is an element.
  if (roots.length === 1 && roots[0].t === 0) {
    const root = genElement(roots[0].el);
    if (root === null) return null;
    lines.push(`return ${root};`);
    return lines.join("\n  ");
  }

  // Otherwise the runtime builds a <div> wrapper. With only element and text
  // roots, the wrapper's child count equals the root count, so the runtime's
  // "unwrap a single element child" branch can never fire here — the fast
  // path above already took that case.
  lines.push(`const w = document.createElement("div");`);
  for (const root of roots) {
    if (root.t === 0) {
      const c = genElement(root.el);
      if (c === null) return null;
      lines.push(`w.appendChild(${c});`);
    } else if (root.t === 1) {
      lines.push(`w.appendChild(document.createTextNode(${q(root.value)}));`);
    } else {
      // A top-level expression: the runtime renders a function value after a
      // `bind:htm` comment owned by the wrapper, and may unwrap a lone Node
      // value. Neither is reproducible through public API — runtime executor.
      return null;
    }
  }
  lines.push("return w;");
  return lines.join("\n  ");
}

/** Module-level helpers, emitted once per file and only when used. */
function helperSource(h: Helpers): string {
  const P = h.prefix;
  const out: string[] = [];
  if (h.used.has("attr")) {
    // Same verdict as the runtime's expression-attribute path: a function is
    // bound reactively via `bindAttribute` and owned by the element; any other
    // value is committed once through `setSafeAttribute`.
    out.push(
      `function ${P}attr(el, name, value) {\n` +
        `  const teardown = ${P}bindAttrs(el, { [name]: value });\n` +
        `  if (typeof value === "function") ${P}registerDisposer(el, teardown);\n` +
        "}",
    );
  }
  if (h.used.has("str")) {
    out.push(`function ${P}str(value) {\n  return value == null ? "" : String(value);\n}`);
  }
  if (h.used.has("on")) {
    // The runtime's development warning, verbatim, behind the same define the
    // build plugins set (`__SIBU_DEV__`), so a production build folds it away.
    out.push(
      `function ${P}on(el, name, handler) {\n` +
        `  if (typeof handler === "function") el.addEventListener(name, handler);\n` +
        `  else if (typeof __SIBU_DEV__ !== "undefined" && __SIBU_DEV__) {\n` +
        "    console.warn(`[SibuJS] html: on:${name} handler is not a function (got ${typeof handler}). Event listener was not attached.`);\n" +
        "  }\n" +
        "}",
    );
  }
  if (h.used.has("child")) {
    // Mirrors the runtime's child-expression branch order exactly: function,
    // Node, array (one level, items stringified — a function INSIDE an array
    // is text at runtime, not a binding), then any other non-null, non-boolean
    // value as text.
    out.push(
      `function ${P}child(el, value) {\n` +
        `  if (typeof value === "function") {\n` +
        // The runtime registers the binding's cleanup on the ELEMENT; Fragment
        // registers it on the placeholder. Owning the placeholder's disposal
        // from the element makes `disposeNodeOwn(el)` release it as well.
        `    const frag = ${P}Fragment([value]);\n` +
        "    const ph = frag.firstChild;\n" +
        "    el.appendChild(frag);\n" +
        `    ${P}registerDisposer(el, () => ${P}dispose(ph));\n` +
        "  } else if (value instanceof Node) {\n" +
        "    el.appendChild(value);\n" +
        "  } else if (Array.isArray(value)) {\n" +
        "    for (let i = 0; i < value.length; i++) {\n" +
        "      const item = value[i];\n" +
        "      if (item instanceof Node) el.appendChild(item);\n" +
        '      else if (item != null && typeof item !== "boolean") el.appendChild(document.createTextNode(String(item)));\n' +
        "    }\n" +
        '  } else if (value != null && typeof value !== "boolean") {\n' +
        "    el.appendChild(document.createTextNode(String(value)));\n" +
        "  }\n" +
        "}",
    );
  }
  return out.join("\n");
}

function importSource(h: Helpers): string {
  const P = h.prefix;
  const core: string[] = [];
  if (h.used.has("child")) core.push(`Fragment as ${P}Fragment`, `dispose as ${P}dispose`);
  if (h.used.has("attr") || h.used.has("child")) core.push(`registerDisposer as ${P}registerDisposer`);
  if (h.used.has("run")) core.push(`__renderParsedTemplate as ${P}run`);
  const lines: string[] = [];
  if (core.length > 0) lines.push(`import { ${core.join(", ")} } from "sibujs";`);
  if (h.used.has("attr")) lines.push(`import { bindAttrs as ${P}bindAttrs } from "sibujs/ui";`);
  return lines.join("\n");
}

/** Record every element a parsed tree creates, for `usedTags` / `usesSvg`. */
function collectTags(children: TmplChild[], h: Helpers): void {
  for (const child of children) {
    if (child.t !== 0) continue;
    h.tags.add(child.el.tag);
    if (child.el.svg) h.svg = true;
    collectTags(child.el.children, h);
  }
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface TemplatePlan {
  /**
   * Edits against the original source. Each compiled template is replaced in
   * place by a call, and each replacement keeps the line breaks of the text it
   * replaces, so every line of the module stays at its original number.
   */
  edits: SourceEdit[];
  /** Imports and helpers the compiled templates need, appended after the last line. */
  append: string;
  usedTags: Set<string>;
  usesSvg: boolean;
  compiledCount: number;
  skippedCount: number;
}

/**
 * Plan the compilation of the sibujs `html` tagged templates in `code`.
 *
 * The call replacing a template keeps the template's expressions IN PLACE:
 * only the template text around them is rewritten —
 *
 *   html`<p title=${a}>${b}</p>`   →   __sibujs$t0((a), (b))
 *
 * — so the expression code (including nested templates, compiled on their
 * own) keeps its original text and position for the source map. Each
 * expression is parenthesized so a top-level comma operator stays one
 * argument; argument evaluation is left-to-right, as in the template.
 *
 * Returns a plan with no edits when nothing was compiled — including when the
 * file cannot be scanned with confidence.
 */
export function planHtmlTemplates(code: string): TemplatePlan {
  const plan: TemplatePlan = {
    edits: [],
    append: "",
    usedTags: new Set(),
    usesSvg: false,
    compiledCount: 0,
    skippedCount: 0,
  };
  if (!code.includes("`") || !code.includes("sibujs")) return plan;
  const scan = scanModule(code);
  if (!scan) return plan;

  // Local names bound to sibujs's `html` template tag.
  const tagNames = new Set<string>();
  for (const decl of scan.imports) {
    if (!isSibuSource(decl.source)) continue;
    for (const b of decl.bindings) if (b.imported === "html") tagNames.add(b.local);
  }
  if (tagNames.size === 0) return plan;

  // Every reference to the tag must be a tagged-template use. Anything else —
  // a declaration, a parameter, an object key, a direct call, passing it as a
  // value — may shadow or alias the import somewhere, and this is not a
  // scope-aware parser, so the whole file is left to the runtime.
  const uses = bindingUses(code, scan, tagNames);
  if (uses.shadowed.size > 0 || uses.calls.length > 0 || uses.tagged.length === 0) return plan;
  const sites = new Set<Token>(uses.tagged.map((ref) => ref.tok));

  const h: Helpers = { prefix: uniquePrefix(code), used: new Set(), tags: new Set(), svg: false };
  const functions: string[] = [];

  /** Compile one template to a construction function; its name, or null to leave it. */
  const compileTemplate = (tmpl: Extract<Token, { type: "template" }>): string | null => {
    // The runtime receives COOKED strings (escapes decoded, CRLF normalized).
    const strings: string[] = [];
    for (const qs of tmpl.quasis) {
      const cooked = cookEscapes(code.slice(qs.start, qs.end));
      if (cooked === null) {
        // An escape with no cooked value reaches the runtime as `undefined`,
        // which its parser reads as the text "undefined" — except in a
        // template that is ONE such quasi, where it fails with an engine
        // TypeError this module cannot reproduce. That one stays runtime.
        if (tmpl.quasis.length === 1) return null;
        strings.push("undefined");
        continue;
      }
      strings.push(cooked);
    }
    const name = `${h.prefix}t${functions.length}`;
    const params = tmpl.exprs.map((_, i) => `v${i}`).join(", ");
    let roots: TmplChild[];
    try {
      roots = parseTemplate(strings);
    } catch (err) {
      // The runtime throws for this template on EVERY call (the failed parse is
      // never cached), after the expressions were evaluated as arguments. A
      // function that throws the same error reproduces both.
      if (err instanceof RuntimeParseError) {
        const message =
          `html: dynamic \${...} expressions are not allowed inside <${err.message}> (raw-text context). ` +
          "Build the content separately and append it as a Node.";
        functions.push(`function ${name}(${params}) {\n  throw new Error(${jsStringLiteral(message)});\n}`);
        return name;
      }
      throw err;
    }
    // Generate into a scratch helper state so a bail-out leaves no trace.
    const scratch: Helpers = { prefix: h.prefix, used: new Set(), tags: new Set(), svg: false };
    const body = generateBody(roots, scratch);
    if (body === null) {
      // Straight-line code cannot reproduce it: hand the parsed tree to the
      // runtime's own executor. The tree is a JSON constant (strings, numbers
      // and booleans only); U+2028/U+2029 are escaped so the literal is valid
      // in every supported engine.
      const tree = JSON.stringify(roots)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
      h.used.add("run");
      collectTags(roots, h);
      // Built on the FIRST call and memoised on the function itself. This code
      // is appended after the module body, so a top-level `const` would still
      // be in its temporal dead zone when a template runs during module
      // evaluation; the function declaration is hoisted.
      functions.push(
        `function ${name}(${params}) {\n  return ${h.prefix}run(${name}.tree || (${name}.tree = ${tree}), [${params}]);\n}`,
      );
      return name;
    }
    for (const u of scratch.used) h.used.add(u);
    for (const t of scratch.tags) h.tags.add(t);
    if (scratch.svg) h.svg = true;

    functions.push(`function ${name}(${params}) {\n  ${body}\n}`);
    return name;
  };

  /** Replace the template text around the expressions, keeping its line breaks. */
  const replaceSite = (tag: Token, tmpl: Extract<Token, { type: "template" }>, name: string) => {
    const edit = (start: number, end: number, before: string, after: string) =>
      plan.edits.push({ start, end, text: `${before}${lineBreaksIn(code, start, end)}${after}` });
    const exprs = tmpl.exprs;
    if (exprs.length === 0) {
      edit(tag.start, tmpl.end, `${name}(`, ")");
      return;
    }
    edit(tag.start, exprs[0].start, `${name}((`, "");
    for (let i = 1; i < exprs.length; i++) edit(exprs[i - 1].end, exprs[i].start, ")", ", (");
    edit(exprs[exprs.length - 1].end, tmpl.end, "", "))");
  };

  const visit = (list: Token[]) => {
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (sites.has(tok)) {
        const tmpl = list[i + 1] as Extract<Token, { type: "template" }>;
        // Nested templates inside the expressions are compiled on their own,
        // so an outer template that stays uncompiled still gets them.
        for (const e of tmpl.exprs) visit(e.tokens);
        const name = compileTemplate(tmpl);
        if (name !== null) {
          plan.compiledCount++;
          replaceSite(tok, tmpl, name);
        } else {
          plan.skippedCount++;
        }
        i++;
      } else if (tok.type === "template") {
        for (const e of tok.exprs) visit(e.tokens);
      }
    }
  };
  visit(scan.tokens);

  if (plan.compiledCount === 0) return { ...plan, edits: [] };
  const trailer = [importSource(h), helperSource(h), ...functions].filter(Boolean).join("\n");
  plan.append = `\n${trailer}\n`;
  plan.usedTags = h.tags;
  plan.usesSvg = h.svg;
  return plan;
}
