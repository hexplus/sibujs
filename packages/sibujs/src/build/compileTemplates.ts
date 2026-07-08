/**
 * Build-time compiler for SibuJS html tagged templates.
 *
 * Transforms:
 *   html`<div class=${cls}><span>${() => count()}</span></div>`
 *
 * Into direct tagFactory calls:
 *   div({ class: __v[0], nodes: [span({ nodes: __v[1] })] })
 *
 * This eliminates the runtime template parser entirely, removing the ~1.5x
 * overhead of the html`` authoring style vs direct function calls.
 *
 * The runtime parser remains available as a fallback for users who don't
 * use a build step.
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface CompiledAttr {
  name: string;
  value:
    | { kind: "static"; value: string }
    | { kind: "expr"; index: number }
    | { kind: "mixed"; parts: Array<{ kind: "static"; value: string } | { kind: "expr"; index: number }> }
    | { kind: "bool" }
    | { kind: "event"; index: number };
}

interface CompiledElement {
  tag: string;
  attrs: CompiledAttr[];
  children: CompiledChild[];
}

type CompiledChild =
  | { kind: "element"; el: CompiledElement }
  | { kind: "text"; value: string }
  | { kind: "expr"; index: number };

// ── Void/SVG sets ────────────────────────────────────────────────────────────

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

// ── Source-level regex to find html`` calls ──────────────────────────────────

/**
 * Find all html`...` tagged template expressions in source code.
 * Returns array of { start, end, strings, exprPositions }.
 */
function findHtmlTemplates(code: string): Array<{
  start: number;
  end: number;
  strings: string[];
  exprCount: number;
}> {
  const results: Array<{ start: number; end: number; strings: string[]; exprCount: number }> = [];

  // Match html` with word boundary before "html"
  const tagRegex = /\bhtml\s*`/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(code)) !== null) {
    const start = match.index;
    const backtickStart = code.indexOf("`", start + 4);
    if (backtickStart === -1) continue;

    // Parse the template literal, handling nested backticks via ${} depth
    const parsed = parseTemplateLiteral(code, backtickStart);
    if (!parsed) continue;

    results.push({
      start,
      end: parsed.end,
      strings: parsed.strings,
      exprCount: parsed.exprCount,
    });

    // Advance regex past this template
    tagRegex.lastIndex = parsed.end;
  }

  return results;
}

/**
 * Parse a template literal starting at the opening backtick.
 * Extracts the static string parts and counts expressions.
 */
function parseTemplateLiteral(
  code: string,
  openBacktick: number,
): {
  end: number;
  strings: string[];
  exprCount: number;
} | null {
  const strings: string[] = [];
  let exprCount = 0;
  let pos = openBacktick + 1; // skip opening `
  let current = "";

  while (pos < code.length) {
    const ch = code[pos];

    if (ch === "`") {
      // End of template literal
      strings.push(current);
      return { end: pos + 1, strings, exprCount };
    }

    if (ch === "$" && pos + 1 < code.length && code[pos + 1] === "{") {
      // Expression: ${...}
      strings.push(current);
      current = "";
      exprCount++;
      pos += 2; // skip ${

      // Find matching } accounting for nested braces, strings, templates
      let depth = 1;
      while (pos < code.length && depth > 0) {
        const c = code[pos];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          pos = skipString(code, pos);
          continue;
        }
        if (depth > 0) pos++;
      }
      if (depth !== 0) return null;
      pos++; // skip closing }
      continue;
    }

    if (ch === "\\") {
      // Escape sequence
      current += code[pos] + (code[pos + 1] || "");
      pos += 2;
      continue;
    }

    current += ch;
    pos++;
  }

  return null; // Unterminated template
}

function skipString(code: string, start: number): number {
  const quote = code[start];
  let pos = start + 1;
  while (pos < code.length) {
    if (code[pos] === "\\") {
      pos += 2;
      continue;
    }
    if (code[pos] === quote) return pos + 1;
    if (quote === "`" && code[pos] === "$" && code[pos + 1] === "{") {
      pos += 2;
      let depth = 1;
      while (pos < code.length && depth > 0) {
        if (code[pos] === "{") depth++;
        else if (code[pos] === "}") depth--;
        else if (code[pos] === '"' || code[pos] === "'" || code[pos] === "`") {
          pos = skipString(code, pos);
          continue;
        }
        if (depth > 0) pos++;
      }
      pos++; // skip }
      continue;
    }
    pos++;
  }
  return pos;
}

// ── Template parser (same logic as runtime, but at build time) ───────────────

function parseTemplateToAST(strings: string[]): CompiledChild[] {
  const exprCount = strings.length - 1;
  let template = strings[0];
  for (let i = 0; i < exprCount; i++) {
    template += `\x00${i}\x00${strings[i + 1]}`;
  }

  let pos = 0;
  const len = template.length;

  function skipWs(): void {
    while (pos < len && /\s/.test(template[pos])) pos++;
  }

  function tryExprIdx(): number {
    if (template[pos] !== "\x00") return -1;
    const start = pos;
    pos++;
    let idxStr = "";
    while (pos < len && template[pos] !== "\x00") idxStr += template[pos++];
    if (pos < len) pos++;
    const idx = Number.parseInt(idxStr, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= exprCount) {
      pos = start;
      return -1;
    }
    return idx;
  }

  function readTagName(): string {
    let name = "";
    while (pos < len && /[a-zA-Z0-9-]/.test(template[pos])) name += template[pos++];
    return name;
  }

  function parseAttrValue(): CompiledAttr["value"] {
    skipWs();
    if (template[pos] !== "=") return { kind: "bool" };
    pos++; // skip =
    skipWs();

    const exprIdx = tryExprIdx();
    if (exprIdx >= 0) return { kind: "expr", index: exprIdx };

    const quote = template[pos];
    if (quote === '"' || quote === "'") {
      pos++;
      const parts: Array<{ kind: "static"; value: string } | { kind: "expr"; index: number }> = [];
      let current = "";
      while (pos < len && template[pos] !== quote) {
        const innerIdx = tryExprIdx();
        if (innerIdx >= 0) {
          if (current) parts.push({ kind: "static", value: current });
          current = "";
          parts.push({ kind: "expr", index: innerIdx });
        } else {
          current += template[pos++];
        }
      }
      if (pos < len) pos++;
      if (current) parts.push({ kind: "static", value: current });

      if (parts.length === 1 && parts[0].kind === "static") {
        return { kind: "static", value: parts[0].value };
      }
      if (parts.some((p) => p.kind === "expr")) {
        return { kind: "mixed", parts };
      }
      return { kind: "static", value: parts.map((p) => (p as { value: string }).value).join("") };
    }

    let val = "";
    while (pos < len && !/[\s>/]/.test(template[pos])) val += template[pos++];
    return { kind: "static", value: val };
  }

  function parseAttrs(): CompiledAttr[] {
    const attrs: CompiledAttr[] = [];
    while (pos < len) {
      skipWs();
      if (template[pos] === ">" || template[pos] === "/") break;
      let attrName = "";
      while (pos < len && /[a-zA-Z0-9\-:_.]/.test(template[pos])) attrName += template[pos++];
      if (!attrName) break;

      const val = parseAttrValue();

      if (attrName.startsWith("on:")) {
        if (val.kind === "expr") {
          attrs.push({ name: attrName.slice(3), value: { kind: "event", index: val.index } });
        }
      } else {
        attrs.push({ name: attrName, value: val });
      }
    }
    return attrs;
  }

  function collapseWs(s: string): string {
    return s.replace(/\s+/g, " ");
  }

  function parseTextChildren(children: CompiledChild[]): void {
    let text = "";
    while (pos < len && template[pos] !== "<") {
      const idx = tryExprIdx();
      if (idx >= 0) {
        const collapsed = collapseWs(text);
        if (collapsed) children.push({ kind: "text", value: collapsed });
        text = "";
        children.push({ kind: "expr", index: idx });
      } else {
        text += template[pos++];
      }
    }
    const collapsed = collapseWs(text);
    if (collapsed) children.push({ kind: "text", value: collapsed });
  }

  function parseChildren(): CompiledChild[] {
    const children: CompiledChild[] = [];
    while (pos < len) {
      if (template[pos] === "<" && pos + 1 < len && template[pos + 1] === "/") break;
      if (template[pos] === "<") {
        pos++;
        const tag = readTagName();
        const attrs = parseAttrs();
        skipWs();
        const isVoid = VOID_ELEMENTS.has(tag);
        const isSelfClosing = template[pos] === "/";
        if (isSelfClosing) pos++;
        if (pos < len) pos++;

        if (isVoid || isSelfClosing) {
          children.push({ kind: "element", el: { tag, attrs, children: [] } });
        } else {
          const inner = parseChildren();
          if (template[pos] === "<" && pos + 1 < len && template[pos + 1] === "/") {
            pos += 2;
            readTagName();
            skipWs();
            if (pos < len && template[pos] === ">") pos++;
          }
          children.push({ kind: "element", el: { tag, attrs, children: inner } });
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

function generateElement(el: CompiledElement, valuesVar: string): string {
  const tag = el.tag;
  const isSvg = SVG_TAGS.has(tag);
  const parts: string[] = [];

  // Attributes
  for (const attr of el.attrs) {
    const v = attr.value;
    switch (v.kind) {
      case "static":
        parts.push(`${JSON.stringify(attr.name)}: ${JSON.stringify(v.value)}`);
        break;
      case "expr":
        parts.push(`${JSON.stringify(attr.name)}: ${valuesVar}[${v.index}]`);
        break;
      case "mixed": {
        const concat = v.parts
          .map((p) => (p.kind === "static" ? JSON.stringify(p.value) : `String(${valuesVar}[${p.index}])`))
          .join(" + ");
        parts.push(`${JSON.stringify(attr.name)}: ${concat}`);
        break;
      }
      case "bool":
        parts.push(`${JSON.stringify(attr.name)}: true`);
        break;
      case "event":
        // Events collected separately
        break;
    }
  }

  // Events
  const events = el.attrs.filter((a) => a.value.kind === "event");
  if (events.length > 0) {
    const eventEntries = events.map((a) => {
      const v = a.value as { kind: "event"; index: number };
      return `${JSON.stringify(a.name)}: ${valuesVar}[${v.index}]`;
    });
    parts.push(`on: { ${eventEntries.join(", ")} }`);
  }

  // Children
  if (el.children.length > 0) {
    const childExprs = el.children.map((c) => generateChild(c, valuesVar));
    if (childExprs.length === 1) {
      parts.push(`nodes: ${childExprs[0]}`);
    } else {
      parts.push(`nodes: [${childExprs.join(", ")}]`);
    }
  }

  const propsStr = parts.length > 0 ? `{ ${parts.join(", ")} }` : undefined;

  if (isSvg) {
    return propsStr
      ? `__sbTagFactory(${JSON.stringify(tag)}, __sbSVG_NS)(${propsStr})`
      : `__sbTagFactory(${JSON.stringify(tag)}, __sbSVG_NS)({})`;
  }

  // Use the tag name directly as a function call (imported from sibu)
  return propsStr ? `${tag}(${propsStr})` : `${tag}({})`;
}

function generateChild(child: CompiledChild, valuesVar: string): string {
  switch (child.kind) {
    case "element":
      return generateElement(child.el, valuesVar);
    case "text":
      return JSON.stringify(child.value);
    case "expr":
      return `${valuesVar}[${child.index}]`;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CompileResult {
  /** The transformed source code, or null if no templates found */
  code: string | null;
  /** Set of HTML tag names used (need to be imported from sibu) */
  usedTags: Set<string>;
  /** Whether any SVG tags were used (needs tagFactory + SVG_NS import) */
  usesSvg: boolean;
  /** Number of templates compiled */
  compiledCount: number;
}

/**
 * Compile all html`` tagged templates in source code to direct tagFactory calls.
 *
 * Transforms:
 *   html`<div class=${cls}><span>${text}</span></div>`
 *
 * Into:
 *   ((v) => div({ class: v[0], nodes: [span({ nodes: v[1] })] }))([cls, text])
 *
 * This eliminates the runtime template parser entirely.
 */
export function compileHtmlTemplates(code: string): CompileResult {
  const templates = findHtmlTemplates(code);
  if (templates.length === 0) {
    return { code: null, usedTags: new Set(), usesSvg: false, compiledCount: 0 };
  }

  const usedTags = new Set<string>();
  let usesSvg = false;
  let result = code;

  // Process from last to first to preserve string indices
  for (let i = templates.length - 1; i >= 0; i--) {
    const tmpl = templates[i];
    const ast = parseTemplateToAST(tmpl.strings);

    // Collect used tags
    collectTags(ast, usedTags);
    // Multiple top-level roots are wrapped in a <div> (matching the runtime
    // `html` tag, which builds a div wrapper for multi-root templates), so the
    // div factory must be imported.
    if (ast.length > 1) usedTags.add("div");
    if (Array.from(usedTags).some((t) => SVG_TAGS.has(t))) usesSvg = true;

    // Generate code
    const valuesVar = "__v";
    const childExprs = ast.map((c) => generateChild(c, valuesVar));
    // A single root renders directly; multiple roots are wrapped in a div
    // containing all of them. Previously both branches emitted only the first
    // child, silently dropping every sibling node.
    const rootExpr = childExprs.length === 1 ? childExprs[0] : `div([${childExprs.join(", ")}])`;

    let compiled: string;
    if (tmpl.exprCount === 0) {
      // No expressions — static template, no wrapper needed
      compiled = rootExpr;
    } else {
      // Wrap in IIFE that receives the expression values
      const body = rootExpr;
      // Extract the original expressions from source
      const exprSource = extractExpressions(code, tmpl.start, tmpl.end, tmpl.exprCount);
      compiled = `((${valuesVar}) => ${body})([${exprSource.join(", ")}])`;
    }

    result = result.slice(0, tmpl.start) + compiled + result.slice(tmpl.end);
  }

  return { code: result, usedTags, usesSvg, compiledCount: templates.length };
}

function collectTags(children: CompiledChild[], tags: Set<string>): void {
  for (const child of children) {
    if (child.kind === "element") {
      tags.add(child.el.tag);
      collectTags(child.el.children, tags);
    }
  }
}

/**
 * Extract the original expression source strings from a template literal.
 */
function extractExpressions(code: string, templateStart: number, templateEnd: number, count: number): string[] {
  const exprs: string[] = [];
  const backtickStart = code.indexOf("`", templateStart + 4);
  let pos = backtickStart + 1;

  for (let i = 0; i < count; i++) {
    // Find next ${
    while (pos < templateEnd) {
      if (code[pos] === "$" && code[pos + 1] === "{") {
        pos += 2;
        break;
      }
      if (code[pos] === "\\") {
        pos += 2;
        continue;
      }
      pos++;
    }

    // Read until matching }
    const exprStart = pos;
    let depth = 1;
    while (pos < templateEnd && depth > 0) {
      const c = code[pos];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === '"' || c === "'" || c === "`") {
        pos = skipString(code, pos);
        continue;
      }
      pos++;
    }
    exprs.push(code.slice(exprStart, pos).trim());
    pos++; // skip }
  }

  return exprs;
}
