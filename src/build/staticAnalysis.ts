/**
 * Static analysis utilities for SibuJS build-time optimizations.
 * Detects tag-factory calls that can be converted to template cloning.
 *
 * A candidate is replaced by `staticTemplate("<markup>")`, so the analysis
 * must PROVE that parsing the markup yields exactly the element the tag
 * factory would have built. The earlier regex version proved nothing: it
 * matched method calls (`db.select({...})`), text inside strings and
 * comments, silently dropped shorthand and spread props while still calling
 * the call static, treated `"a" + x` as a literal, and rendered `false` as
 * `disabled="false"`. Every one of those is a production-only bug.
 *
 * The rule now is: optimize only what is provably equivalent, and leave
 * everything else untouched. Concretely a call qualifies only when
 *   - the callee is a tag factory imported from "sibujs" (by any local alias),
 *     called directly — never `obj.tag(...)` — and the name is not declared
 *     or used anywhere in the file in a way that could shadow the import (a
 *     local `function div() {}`, a `div() {}` method, a parameter, ...);
 *   - the tag is in `STATIC_TAGS` (no table/select/pre/textarea parsing
 *     quirks, no URL- or script-bearing elements);
 *   - the arguments are `({...})`, `({...}, "text")`, `("text")` or
 *     `("class", "text")`, where the object literal holds only plain or quoted
 *     keys with string / number / `true` / `false` / `null` / `undefined`
 *     literal values — no shorthand, spread, computed keys, methods, or
 *     expressions of any kind;
 *   - every attribute goes through a tag-factory path that is a plain
 *     `setAttribute` for that value (see `attributeHtml`).
 */

import { isEventHandlerAttr, isHtmlContentAttribute, isUrlAttribute } from "../utils/sanitize";
import { bindingUses, scanModule, stringTokenValue, type Token } from "./sourceScan";

export interface StaticAnalysisResult {
  /** Whether any static patterns were found */
  hasStaticPatterns: boolean;
  /** Detected static patterns with replacement info */
  patterns: Array<{
    /** Original source code of the call */
    original: string;
    /** The tag name (e.g., "div", "span") */
    tag: string;
    /** Static HTML that can be used as a template */
    templateHtml: string;
    /** Start index in original source */
    start: number;
    /** End index in original source */
    end: number;
  }>;
}

/**
 * Tags whose markup round-trips through the HTML parser (inside a
 * `<template>`) to exactly the element `document.createElement` produces.
 *
 * Deliberately excluded: table-structure tags (text children are
 * foster-parented out), `select`/`option`/`textarea`/`pre` (parser text
 * rules), and anything whose purpose is a URL or script.
 */
const STATIC_TAGS = new Set([
  "div",
  "span",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "li",
  "ol",
  "ul",
  "a",
  "b",
  "em",
  "i",
  "strong",
  "small",
  "code",
  "mark",
  "img",
  "br",
  "hr",
  "input",
  "button",
  "form",
  "label",
  "details",
  "summary",
  "dialog",
]);

const VOID_ELEMENTS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Tag-factory props with special (non-attribute) meaning. */
const SPECIAL_PROPS = new Set(["style", "ref", "on", "onElement"]);

/**
 * Boolean props the tag factory writes through the IDL property WITHOUT the
 * content attribute reflecting it — `input({ checked: true })` has no
 * `checked` attribute, while the markup `<input checked>` does.
 */
const NON_REFLECTING_BOOLEANS = new Set(["checked", "selected"]);

type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "keyword"; value: string };

function readLiteral(code: string, tok: Token | undefined): Literal | null {
  if (!tok) return null;
  if (tok.type === "string") {
    const value = stringTokenValue(code, tok);
    return value === null ? null : { kind: "string", value };
  }
  // Plain decimal literals only: String(n) must reproduce the source digits'
  // value, and hex/exponent/separator forms are not worth the proof.
  if (tok.type === "number" && /^(0|[1-9]\d*)(\.\d+)?$/.test(tok.value)) {
    return { kind: "number", value: String(Number(tok.value)) };
  }
  if (tok.type === "ident" && ["true", "false", "null", "undefined"].includes(tok.value)) {
    return { kind: "keyword", value: tok.value };
  }
  return null;
}

/**
 * Text the HTML parser would alter: CR (normalized to LF), NUL (dropped or
 * replaced). A leading newline is only special in pre/textarea/listing, which
 * are not in STATIC_TAGS.
 */
function parserSafeText(s: string): boolean {
  return !s.includes("\r") && !s.includes("\0");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The markup for one generic prop, `""` when the tag factory writes nothing,
 * or `null` when the factory's result is not a plain `setAttribute` of this
 * literal (sanitized names, IDL-only booleans, special props).
 *
 * Mirrors `setSafeAttribute` for a FIRST render (`syncValueProperty: false`):
 * null/undefined are skipped, `aria-*` booleans serialize as "true"/"false",
 * other `true` is presence and `false` is absence, strings and numbers are
 * written as text.
 */
function attributeHtml(name: string, lit: Literal): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) return null;
  const lower = name.toLowerCase();
  if (SPECIAL_PROPS.has(name) || lower === "style" || lower === "srcset") return null;
  if (isEventHandlerAttr(name) || isUrlAttribute(name) || isHtmlContentAttribute(name)) return null;

  if (lit.kind === "keyword") {
    if (lit.value === "null" || lit.value === "undefined") return "";
    const on = lit.value === "true";
    if (lower.startsWith("aria-")) return `${lower}="${on}"`;
    if (NON_REFLECTING_BOOLEANS.has(lower)) return null;
    return on ? `${lower}=""` : "";
  }
  if (!parserSafeText(lit.value)) return null;
  return `${lower}="${escapeAttr(lit.value)}"`;
}

interface ParsedCall {
  end: number;
  cls: string | null;
  id: string | null;
  attrs: string[];
  text: string | null;
}

/**
 * Parse the argument list starting at the `(` token `list[i]`. Returns `null`
 * for anything that is not provably static.
 */
function parseCall(code: string, list: Token[], i: number): ParsedCall | null {
  const at = (k: number) => list[k];
  const isPunct = (k: number, v: string) => {
    const t = at(k);
    return !!t && t.type === "punct" && t.value === v;
  };

  let k = i + 1;
  const result: ParsedCall = { end: 0, cls: null, id: null, attrs: [], text: null };
  let nodesText: string | null = null;

  if (isPunct(k, "{")) {
    k++;
    const seen = new Set<string>();
    while (!isPunct(k, "}")) {
      const keyTok = at(k);
      let key: string | null = null;
      if (keyTok?.type === "ident") key = keyTok.value;
      else if (keyTok?.type === "string") key = stringTokenValue(code, keyTok);
      // Shorthand (`{ value }`), spread, computed keys and methods all fail
      // here or at the `:` check below.
      if (key === null || !isPunct(k + 1, ":")) return null;
      // HTML attribute names are case-insensitive: `{ id, ID }` writes one
      // attribute twice (last wins) but the markup would keep the first.
      if (seen.has(key.toLowerCase())) return null;
      seen.add(key.toLowerCase());
      const lit = readLiteral(code, at(k + 2));
      if (lit === null) return null;
      k += 3;
      if (isPunct(k, ",")) k++;
      else if (!isPunct(k, "}")) return null; // e.g. `"a" + x`

      if (key === "class" || key === "id") {
        // The factory writes class via setAttribute and id via `el.id` — both
        // a plain attribute write, but only for a string. Other literal types
        // take different paths (a number class renders `class=""`).
        if (lit.kind !== "string" || !parserSafeText(lit.value)) return null;
        if (key === "class") result.cls = lit.value;
        else result.id = lit.value;
      } else if (key === "nodes") {
        if (lit.kind !== "string" || !parserSafeText(lit.value)) return null;
        nodesText = lit.value;
      } else {
        const html = attributeHtml(key, lit);
        if (html === null) return null;
        if (html) result.attrs.push(html);
      }
    }
    k++; // }
    if (isPunct(k, ",")) {
      const second = readLiteral(code, at(k + 1));
      if (second === null) {
        if (!isPunct(k + 1, ")")) return null; // trailing comma
        k++;
      } else {
        if (second.kind !== "string" || !parserSafeText(second.value)) return null;
        result.text = second.value; // positional children beat `nodes`
        k += 2;
        if (isPunct(k, ",")) k++;
      }
    }
    if (result.text === null) result.text = nodesText;
  } else {
    // `tag("text")` or `tag("class", "text")`
    const first = readLiteral(code, at(k));
    if (first === null || first.kind !== "string" || !parserSafeText(first.value)) return null;
    k++;
    if (isPunct(k, ",") && at(k + 1)?.type === "string") {
      const second = readLiteral(code, at(k + 1));
      if (second === null || second.kind !== "string" || !parserSafeText(second.value)) return null;
      result.cls = first.value;
      result.text = second.value;
      k += 2;
    } else {
      result.text = first.value;
    }
    if (isPunct(k, ",")) k++;
  }

  if (!isPunct(k, ")")) return null;
  result.end = (at(k) as Token).end;
  return result;
}

function toHtml(tag: string, call: ParsedCall): string | null {
  // Attribute order follows the factory: class, then id, then the rest in
  // key order.
  const attrs: string[] = [];
  if (call.cls !== null) attrs.push(`class="${escapeAttr(call.cls)}"`);
  if (call.id !== null) attrs.push(`id="${escapeAttr(call.id)}"`);
  attrs.push(...call.attrs);
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  if (VOID_ELEMENTS.has(tag)) {
    // A void element's text is written to textContent by the factory, but the
    // markup cannot express it.
    if (call.text) return null;
    return `<${tag}${attrStr} />`;
  }
  return `<${tag}${attrStr}>${escapeHtml(call.text ?? "")}</${tag}>`;
}

/**
 * Analyze source code for static tag-factory calls that can be converted to
 * template cloning at build time.
 *
 * Detects calls like:
 *   div({ class: "card", id: "main" }, "Hello")
 *
 * And identifies them as candidates for:
 *   staticTemplate('<div class="card" id="main">Hello</div>')
 *
 * Only calls to tag factories imported from "sibujs" in this file are
 * considered, and only when every argument is provably static.
 */
export function analyzeStaticTemplates(code: string): StaticAnalysisResult {
  const none: StaticAnalysisResult = { hasStaticPatterns: false, patterns: [] };
  if (!code.includes("sibujs")) return none;
  const scan = scanModule(code);
  if (!scan) return none;

  // local name → tag name, for tag factories imported from the package root.
  const factories = new Map<string, string>();
  for (const decl of scan.imports) {
    if (decl.source !== "sibujs") continue;
    for (const b of decl.bindings) if (STATIC_TAGS.has(b.imported)) factories.set(b.local, b.imported);
  }
  if (factories.size === 0) return none;

  // Only direct calls of names the file never shadows (see `bindingUses`).
  const uses = bindingUses(code, scan, new Set(factories.keys()));
  const unsafe = new Set(uses.shadowed);
  for (const ref of uses.tagged) unsafe.add(ref.tok.value);

  const patterns: StaticAnalysisResult["patterns"] = [];
  for (const { tok, list, index } of uses.calls) {
    if (unsafe.has(tok.value)) continue;
    const tag = factories.get(tok.value) as string;
    const call = parseCall(code, list, index + 1);
    if (!call) continue;
    const templateHtml = toHtml(tag, call);
    if (templateHtml === null) continue;
    const start = list[index].start;
    patterns.push({ original: code.slice(start, call.end), tag, templateHtml, start, end: call.end });
  }

  return { hasStaticPatterns: patterns.length > 0, patterns };
}
