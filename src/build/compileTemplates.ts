/**
 * Build-time compiler for SibuJS html tagged templates.
 *
 * Transforms:
 *   html`<div class=${cls}><span>${() => count()}</span></div>`
 *
 * Into a module-level construction function plus a call that passes the
 * template's expressions in their original order:
 *
 *   __sibujs$t0((cls), (() => count()))
 *   ...
 *   function __sibujs$t0(v0, v1) { ...direct DOM construction... }
 *
 * A compiled template builds exactly the DOM the runtime `html` parser would;
 * any template the compiler cannot reproduce exactly is left to the runtime.
 * The contract, the parser port and the list of templates left to the runtime
 * are documented in templateCompiler.ts.
 */

import { applyEdits, normalizeEdits } from "./sourceEdit";
import { planHtmlTemplates } from "./templateCompiler";

export interface CompileResult {
  /** The transformed source code, or null if nothing was compiled */
  code: string | null;
  /** Tag names of the elements the compiled templates create */
  usedTags: Set<string>;
  /** Whether any compiled template creates SVG-namespace elements */
  usesSvg: boolean;
  /** Number of templates compiled */
  compiledCount: number;
  /** Number of sibujs `html` templates deliberately left to the runtime parser */
  skippedCount: number;
}

/**
 * Compile the sibujs `html` tagged templates in a module to direct DOM
 * construction. The returned code is self-contained: it carries the aliased
 * imports and helpers the compiled templates need, appended at the end of the
 * module (imports are hoisted, and appending keeps every original line where
 * it was — each compiled template also keeps the line breaks it spanned).
 *
 * Returns `code: null` when nothing was compiled — including when the file
 * cannot be scanned with confidence.
 */
export function compileHtmlTemplates(code: string): CompileResult {
  const plan = planHtmlTemplates(code);
  const edits = plan.compiledCount > 0 ? normalizeEdits(plan.edits) : null;
  return {
    code: edits ? applyEdits(code, edits, plan.append) : null,
    usedTags: plan.usedTags,
    usesSvg: plan.usesSvg,
    compiledCount: edits ? plan.compiledCount : 0,
    skippedCount: plan.skippedCount,
  };
}
