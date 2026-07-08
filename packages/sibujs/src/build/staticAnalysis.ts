/**
 * Static analysis utilities for SibuJS build-time optimizations.
 * Detects tagFactory calls that can be converted to template cloning.
 */

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

const HTML_TAGS = new Set([
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
  "pre",
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
  "select",
  "textarea",
  "option",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "td",
  "th",
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

/**
 * Analyze source code for static tagFactory patterns that can be
 * converted to template cloning at build time.
 *
 * Detects patterns like:
 *   div({ class: "card", id: "main" }, "Hello")
 *
 * And identifies them as candidates for:
 *   staticTemplate('<div class="card" id="main">Hello</div>')
 */
export function analyzeStaticTemplates(code: string): StaticAnalysisResult {
  const patterns: StaticAnalysisResult["patterns"] = [];

  const tagCallRegex = new RegExp(`\\b(${Array.from(HTML_TAGS).join("|")})\\s*\\(\\s*\\{([^}]*)\\}\\s*\\)`, "g");

  let match: RegExpExecArray | null;
  while ((match = tagCallRegex.exec(code)) !== null) {
    const [fullMatch, tag, propsContent] = match;
    const start = match.index;
    const end = start + fullMatch.length;

    if (isStaticPropsContent(propsContent)) {
      const templateHtml = propsToHtml(tag, propsContent);
      if (templateHtml) {
        patterns.push({ original: fullMatch, tag, templateHtml, start, end });
      }
    }
  }

  return {
    hasStaticPatterns: patterns.length > 0,
    patterns,
  };
}

/**
 * Check if a props object literal contains only static values.
 * Rejects any function values, refs, event handlers, or variable references.
 */
function isStaticPropsContent(propsContent: string): boolean {
  if (/=>|function\s*\(|\bref\b|\bon\s*:/.test(propsContent)) {
    return false;
  }

  const props = propsContent
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const prop of props) {
    const colonIndex = prop.indexOf(":");
    if (colonIndex === -1) continue;

    const value = prop.substring(colonIndex + 1).trim();
    if (!isStaticValue(value)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a value expression is a static literal.
 */
function isStaticValue(value: string): boolean {
  // String literal (single or double quoted)
  if (/^["'].*["']$/.test(value)) return true;
  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  // Boolean
  if (value === "true" || value === "false") return true;
  // null/undefined
  if (value === "null" || value === "undefined") return true;

  return false;
}

/**
 * Convert static props content into an HTML template string.
 */
function propsToHtml(tag: string, propsContent: string): string | null {
  const attrs: string[] = [];
  let nodesContent = "";

  const props = propsContent
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const prop of props) {
    const colonIndex = prop.indexOf(":");
    if (colonIndex === -1) continue;

    const key = prop.substring(0, colonIndex).trim();
    let value = prop.substring(colonIndex + 1).trim();

    // Remove quotes from string values
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === "nodes") {
      nodesContent = escapeHtml(value);
    } else if (key === "class" || key === "id") {
      attrs.push(`${key}="${escapeAttr(value)}"`);
    } else if (key !== "on" && key !== "ref" && key !== "style") {
      attrs.push(`${key}="${escapeAttr(String(value))}"`);
    }
  }

  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrStr} />`;
  }

  return `<${tag}${attrStr}>${nodesContent}</${tag}>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
