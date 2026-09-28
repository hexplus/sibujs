/**
 * Execution harness for the build transforms.
 *
 * The transforms used to be tested by substring: "the output contains `div(`".
 * That passed while the output imported from a package that does not exist,
 * called a string, or rendered different DOM than the runtime. This harness
 * RUNS transformed module source against the real runtime (the src/ modules)
 * so tests can compare what a compiled module builds with what the untouched
 * module builds.
 *
 * Bare specifiers are resolved against an explicit export table. Importing a
 * name a sibujs entry does not export — or a module that is not a sibujs entry
 * — throws, which is exactly the class of bug a substring test cannot see.
 */

import { context } from "../../src/core/rendering/context";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { Fragment } from "../../src/core/rendering/fragment";
import { __renderParsedTemplate, html as runtimeHtml } from "../../src/core/rendering/htm";
import * as tags from "../../src/core/rendering/html";
import { SVG_NS, tagFactory } from "../../src/core/rendering/tagFactory";
import { signal } from "../../src/core/signals/signal";
import { staticTemplate } from "../../src/performance/compiled";
import { bindAttrs } from "../../src/ui/reactiveAttr";

/** Export tables for the package entries the transforms may reference. */
export const MODULES: Record<string, Record<string, unknown>> = {
  // `html` is exported from the root twice (the `<html>` tag factory via the
  // wildcard, the template tag explicitly); the explicit export wins.
  sibujs: {
    ...tags,
    html: runtimeHtml,
    __renderParsedTemplate,
    Fragment,
    dispose,
    registerDisposer,
    SVG_NS,
    tagFactory,
    signal,
    context,
  },
  "sibujs/ui": { bindAttrs },
  "sibujs/performance": { staticTemplate },
};

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2;?/g;

/**
 * Evaluate ES module source whose only imports are named imports from sibujs
 * entries, and return its default export. Imports are hoisted to the top, as
 * the module system would.
 */
export function runModule<T = unknown>(source: string): T {
  const bindings: string[] = [];
  const body = source
    .replace(IMPORT_RE, (_m, specs: string, _q: string, from: string) => {
      const mod = MODULES[from];
      if (!mod) throw new Error(`harness: import from unknown module "${from}"`);
      const parts = specs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [imported, local = imported] = s.split(/\s+as\s+/);
          if (!(imported in mod)) throw new Error(`harness: "${from}" has no export "${imported}"`);
          return imported === local ? imported : `${imported}: ${local}`;
        });
      bindings.push(`const { ${parts.join(", ")} } = __mods[${JSON.stringify(from)}];`);
      return "";
    })
    .replace(/\bexport default\b/, "return");
  // Any import form not rewritten above stays in the body and is a
  // SyntaxError inside `new Function`, so it cannot pass silently.
  return new Function("__mods", `${bindings.join("\n")}\n${body}`)(MODULES) as T;
}

/**
 * Structural description of a DOM subtree: namespaces, tag names, attributes
 * in order (with namespaces), text and comment nodes. Stricter than
 * outerHTML, which hides namespaces.
 */
export function describeNode(node: Node): string {
  if (node.nodeType === 3) return `#text(${JSON.stringify(node.nodeValue)})`;
  if (node.nodeType === 8) return `#comment(${JSON.stringify(node.nodeValue)})`;
  if (node.nodeType === 11) return `#fragment[${Array.from(node.childNodes).map(describeNode).join(",")}]`;
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.namespaceURI ? `{${a.namespaceURI}}` : ""}${a.name}=${JSON.stringify(a.value)}`)
    .join(" ");
  const kids = Array.from(el.childNodes).map(describeNode).join(",");
  return `<{${el.namespaceURI}}${el.localName}${attrs ? ` ${attrs}` : ""}>[${kids}]`;
}

// ── Source maps ─────────────────────────────────────────────────────────────

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One decoded mapping segment (0-based lines and columns). */
export interface MapSegment {
  genLine: number;
  genCol: number;
  srcLine: number;
  srcCol: number;
}

/**
 * Decode the `mappings` of a v3 source map. Throws on anything malformed
 * (bad base64, a segment without a source position, a negative position), so
 * a test calling it also asserts the map is well formed.
 */
export function decodeMappings(mappings: string): MapSegment[] {
  const out: MapSegment[] = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  mappings.split(";").forEach((line, genLine) => {
    let genCol = 0;
    if (line === "") return;
    for (const segment of line.split(",")) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = BASE64.indexOf(ch);
        if (digit === -1) throw new Error(`bad base64 digit ${JSON.stringify(ch)}`);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      if (shift !== 0) throw new Error("truncated VLQ");
      if (fields.length !== 4 && fields.length !== 5) throw new Error(`segment with ${fields.length} fields`);
      genCol += fields[0];
      srcIndex += fields[1];
      srcLine += fields[2];
      srcCol += fields[3];
      if (genCol < 0 || srcIndex !== 0 || srcLine < 0 || srcCol < 0) throw new Error("invalid segment");
      out.push({ genLine, genCol, srcLine, srcCol });
    }
  });
  return out;
}

/**
 * The original position of a generated position: the last segment on that
 * generated line at or before the column, as source-map consumers resolve it.
 */
export function originalPositionFor(
  segments: MapSegment[],
  genLine: number,
  genCol: number,
): { line: number; column: number } | null {
  let best: MapSegment | null = null;
  for (const s of segments) {
    if (s.genLine === genLine && s.genCol <= genCol && (!best || s.genCol >= best.genCol)) best = s;
  }
  return best && { line: best.srcLine, column: best.srcCol };
}

/** 0-based line and column of the first occurrence of `needle` in `text`. */
export function positionOf(text: string, needle: string): { line: number; column: number } {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`${JSON.stringify(needle)} not found`);
  const before = text.slice(0, at);
  const line = before.split("\n").length - 1;
  return { line, column: at - (before.lastIndexOf("\n") + 1) };
}

/** Describe a returned root, including what it is attached to. */
export function describeRoot(node: Node): string {
  const parent = node.parentNode ? node.parentNode.nodeName : "null";
  const owner = node.ownerDocument === document ? "document" : "other-document";
  return `${describeNode(node)} parent=${parent} owner=${owner}`;
}
