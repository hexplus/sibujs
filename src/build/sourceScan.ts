/**
 * A small JavaScript/TypeScript token scanner shared by the build transforms.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every build transform used to find its targets with a regular expression
 * over raw source text. A regex cannot tell code from a string, a comment or a
 * template literal, cannot tell `div(` from `db.div(`, and cannot tell a
 * SibuJS import from a local function that happens to share its name. Each of
 * those blind spots produced a broken production bundle: pure annotations
 * inside string literals, `x.form({...})` rewritten into markup, a user's own
 * `context()` marked side-effect free and deleted by the minifier.
 *
 * This scanner is deliberately NOT a parser. It only answers the questions the
 * transforms need — "is this identifier real code, what precedes and follows
 * it, which names does this file import from sibujs" — and it FAILS CLOSED:
 * anything it cannot lex with confidence (JSX text with an apostrophe, a regex
 * it misreads, an unterminated literal) makes `tokenize` return `null`, and
 * every caller treats `null` as "leave the file untouched".
 *
 * Internal to the build tooling; not re-exported from `sibujs/build`.
 */

import { applyEdits, normalizeEdits, type SourceEdit } from "./sourceEdit";

export interface TemplatePart {
  /** Offset of the first character after `${`. */
  start: number;
  /** Offset of the closing `}`. */
  end: number;
  /** Tokens of the embedded expression. */
  tokens: Token[];
}

export type Token =
  | { type: "ident"; start: number; end: number; value: string }
  | { type: "punct"; start: number; end: number; value: string }
  | { type: "number"; start: number; end: number; value: string }
  | { type: "string"; start: number; end: number }
  | { type: "regex"; start: number; end: number }
  | {
      type: "template";
      start: number;
      end: number;
      /** Raw text ranges between the backticks and `${ }` holes. */
      quasis: Array<{ start: number; end: number }>;
      exprs: TemplatePart[];
    };

// Keywords after which a `/` starts a regular expression rather than a
// division. Any other identifier (a value) before `/` means division.
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function isIdentStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

class ScanError extends Error {}

/**
 * Instrumentation for tests: how many times a source was actually lexed.
 * Every transform of a module shares one scan (see `scanModule`); the tests
 * use this counter to keep it that way.
 */
export const scanStats = { tokenize: 0 };

/**
 * Tokenize `code`. Returns `null` when the source cannot be lexed with
 * confidence — callers must then leave the file unchanged.
 */
export function tokenize(code: string): Token[] | null {
  scanStats.tokenize++;
  let pos = 0;
  const len = code.length;

  // A hashbang is only legal at offset 0 and is not JavaScript.
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    pos = nl === -1 ? len : nl;
  }

  function regexAllowed(prev: Token | undefined): boolean {
    if (!prev) return true;
    switch (prev.type) {
      case "number":
      case "string":
      case "regex":
      case "template":
        return false;
      case "ident":
        return REGEX_AFTER_KEYWORD.has(prev.value);
      case "punct":
        // `)` and `]` end a value, so `/` after them divides. `}` is ambiguous
        // (block end vs object literal); a block end is far more common before
        // a regex than an object literal is before a division, and a wrong
        // guess surfaces as an unterminated regex, which fails closed.
        return prev.value !== ")" && prev.value !== "]";
    }
  }

  function skipTrivia(): void {
    while (pos < len) {
      const c = code.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) {
        pos++;
      } else if (c === 0x2028 || c === 0x2029) {
        pos++;
      } else if (c === 47 && code.charCodeAt(pos + 1) === 47) {
        // Line comment
        pos += 2;
        while (pos < len) {
          const d = code.charCodeAt(pos);
          if (d === 10 || d === 13 || d === 0x2028 || d === 0x2029) break;
          pos++;
        }
      } else if (c === 47 && code.charCodeAt(pos + 1) === 42) {
        // Block comment
        const end = code.indexOf("*/", pos + 2);
        if (end === -1) throw new ScanError("unterminated comment");
        pos = end + 2;
      } else {
        break;
      }
    }
  }

  function readString(): Token {
    const start = pos;
    const quote = code[pos];
    pos++;
    while (pos < len) {
      const c = code[pos];
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === quote) {
        pos++;
        return { type: "string", start, end: pos };
      }
      // An unescaped line break cannot occur inside a string literal. Seeing
      // one means the quote was not a string delimiter (JSX text, a misread
      // regex), so the scan is no longer trustworthy.
      if (c === "\n" || c === "\r") throw new ScanError("line break in string");
      pos++;
    }
    throw new ScanError("unterminated string");
  }

  function readRegex(): Token {
    const start = pos;
    pos++; // opening /
    let inClass = false;
    while (pos < len) {
      const c = code[pos];
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "\n" || c === "\r") throw new ScanError("line break in regex");
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "/") {
        pos++;
        while (pos < len && isIdentPart(code.charCodeAt(pos))) pos++; // flags
        return { type: "regex", start, end: pos };
      }
      pos++;
    }
    throw new ScanError("unterminated regex");
  }

  function readTemplate(): Token {
    const start = pos;
    pos++; // opening backtick
    const quasis: Array<{ start: number; end: number }> = [];
    const exprs: TemplatePart[] = [];
    let quasiStart = pos;
    while (pos < len) {
      const c = code[pos];
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "`") {
        quasis.push({ start: quasiStart, end: pos });
        pos++;
        return { type: "template", start, end: pos, quasis, exprs };
      }
      if (c === "$" && code[pos + 1] === "{") {
        quasis.push({ start: quasiStart, end: pos });
        pos += 2;
        const exprStart = pos;
        const tokens = readList(true);
        // readList(true) stops AT the closing brace.
        exprs.push({ start: exprStart, end: pos, tokens });
        pos++;
        quasiStart = pos;
        continue;
      }
      pos++;
    }
    throw new ScanError("unterminated template");
  }

  function readList(inTemplateExpr: boolean): Token[] {
    const tokens: Token[] = [];
    let depth = 0;
    for (;;) {
      skipTrivia();
      if (pos >= len) {
        if (inTemplateExpr || depth !== 0) throw new ScanError("unexpected end of input");
        return tokens;
      }
      const c = code.charCodeAt(pos);
      const prev = tokens[tokens.length - 1];

      if (c === 34 || c === 39) {
        tokens.push(readString());
      } else if (c === 96) {
        tokens.push(readTemplate());
      } else if (isIdentStart(c) || c === 92 /* \u escape in identifier */) {
        const start = pos;
        pos++;
        while (pos < len) {
          const d = code.charCodeAt(pos);
          if (isIdentPart(d)) pos++;
          else if (d === 92) pos += 2;
          else break;
        }
        tokens.push({ type: "ident", start, end: pos, value: code.slice(start, pos) });
      } else if (isDigit(c) || (c === 46 && isDigit(code.charCodeAt(pos + 1)))) {
        const start = pos;
        pos++;
        while (pos < len) {
          const d = code.charCodeAt(pos);
          if (isIdentPart(d) || d === 46) pos++;
          else break;
        }
        tokens.push({ type: "number", start, end: pos, value: code.slice(start, pos) });
      } else if (c === 47 && regexAllowed(prev)) {
        tokens.push(readRegex());
      } else {
        const start = pos;
        let value = code[pos];
        if (code.startsWith("...", pos)) value = "...";
        else if (code.startsWith("?.", pos) && !isDigit(code.charCodeAt(pos + 2))) value = "?.";
        else if (code.startsWith("=>", pos)) value = "=>";
        pos += value.length;
        if (value === "{") {
          depth++;
        } else if (value === "}") {
          if (depth === 0) {
            if (inTemplateExpr) {
              pos = start; // leave the closing brace for readTemplate
              return tokens;
            }
            throw new ScanError("unbalanced brace");
          }
          depth--;
        }
        tokens.push({ type: "punct", start, end: pos, value });
      }
    }
  }

  try {
    return readList(false);
  } catch (err) {
    if (err instanceof ScanError) return null;
    throw err;
  }
}

/**
 * Decode the escape sequences of a string-literal body or a template-literal
 * quasi into its COOKED value — the string the runtime actually receives.
 *
 * Returns `null` for an escape the cooked value cannot represent (a legacy
 * octal, `\8`, a malformed `\x`/`\u`). A tagged template receives `undefined`
 * for such a quasi, so no compile-time value would match; callers bail out.
 */
export function cookEscapes(raw: string): string | null {
  let out = "";
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (ch === "\r") {
      // Template literals normalize CR and CRLF line terminators to LF.
      out += "\n";
      i += raw[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const e = raw[i + 1];
    i += 2;
    switch (e) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        if (i < n && isDigit(raw.charCodeAt(i))) return null;
        out += "\0";
        break;
      case "x": {
        const hex = raw.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        if (raw[i] === "{") {
          const close = raw.indexOf("}", i);
          if (close === -1) return null;
          const hex = raw.slice(i + 1, close);
          if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
          out += String.fromCodePoint(cp);
          i = close + 1;
        } else {
          const hex = raw.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      case "\r":
        // Line continuation (CRLF or lone CR) contributes nothing.
        if (raw[i] === "\n") i++;
        break;
      case "\n":
      case "\u2028":
      case "\u2029":
        break;
      case undefined:
        return null;
      default:
        if (isDigit(e.charCodeAt(0))) return null; // \1-\9: legacy octal / invalid
        out += e;
    }
  }
  return out;
}

/** The cooked value of a string-literal token, or `null` if it has an escape we refuse. */
export function stringTokenValue(code: string, tok: Token): string | null {
  if (tok.type !== "string") return null;
  return cookEscapes(code.slice(tok.start + 1, tok.end - 1));
}

// ── Imports ─────────────────────────────────────────────────────────────────

export interface ImportBinding {
  /** Name exported by the source module (`default` / `*` for those forms). */
  imported: string;
  /** Local binding name in this file. */
  local: string;
}

export interface ImportDecl {
  source: string;
  bindings: ImportBinding[];
  /** Offset of the `import` keyword. */
  start: number;
  /** Offset just past the declaration (including a trailing `;`). */
  end: number;
}

/**
 * Collect the top-level `import … from "…"` declarations of a module.
 * Type-only imports (`import type`, `{ type X }`) are skipped: they create no
 * runtime binding. Returns `null` if an import has a shape this scanner does
 * not understand, so callers can fail closed.
 */
export function collectImports(code: string, tokens: Token[]): ImportDecl[] | null {
  const decls: ImportDecl[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== "ident" || tok.value !== "import") continue;
    const prev = tokens[i - 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) continue;
    const next = tokens[i + 1];
    if (!next) return null;
    // `import(...)` (dynamic) and `import.meta` are expressions, not declarations.
    if (next.type === "punct" && (next.value === "(" || next.value === ".")) continue;

    let j = i + 1;
    const bindings: ImportBinding[] = [];
    let typeOnly = false;

    if (next.type === "string") {
      // Side-effect import: `import "x";`
      const source = stringTokenValue(code, next);
      if (source === null) return null;
      let end = next.end;
      const semi = tokens[j + 1];
      if (semi && semi.type === "punct" && semi.value === ";") end = semi.end;
      decls.push({ source, bindings, start: tok.start, end });
      continue;
    }

    const at = (k: number) => tokens[k];
    const isPunct = (k: number, v: string) => {
      const t = at(k);
      return !!t && t.type === "punct" && t.value === v;
    };
    const isIdent = (k: number, v?: string) => {
      const t = at(k);
      return !!t && t.type === "ident" && (v === undefined || t.value === v);
    };

    // `import type X from` / `import type { … } from` — no runtime binding.
    if (isIdent(j, "type") && !isIdent(j + 1, "from") && !isPunct(j + 1, ",")) {
      typeOnly = true;
      j++;
    }

    // Default binding
    if (isIdent(j) && !isIdent(j, "from")) {
      bindings.push({ imported: "default", local: (at(j) as { value: string }).value });
      j++;
      if (isPunct(j, ",")) j++;
    }
    if (isPunct(j, "*")) {
      if (!isIdent(j + 1, "as") || !isIdent(j + 2)) return null;
      bindings.push({ imported: "*", local: (at(j + 2) as { value: string }).value });
      j += 3;
    } else if (isPunct(j, "{")) {
      j++;
      while (!isPunct(j, "}")) {
        const t = at(j);
        if (!t) return null;
        let specTypeOnly = false;
        if (isIdent(j, "type") && (isIdent(j + 1) || at(j + 1)?.type === "string") && !isIdent(j + 1, "as")) {
          specTypeOnly = true;
          j++;
        }
        const nameTok = at(j);
        let imported: string | null = null;
        if (nameTok?.type === "ident") imported = nameTok.value;
        else if (nameTok?.type === "string") imported = stringTokenValue(code, nameTok);
        if (imported === null) return null;
        j++;
        let local = imported;
        if (isIdent(j, "as")) {
          if (!isIdent(j + 1)) return null;
          local = (at(j + 1) as { value: string }).value;
          j += 2;
        }
        if (!specTypeOnly) bindings.push({ imported, local });
        if (isPunct(j, ",")) j++;
        else if (!isPunct(j, "}")) return null;
      }
      j++; // }
    }
    if (!isIdent(j, "from")) return null;
    const srcTok = at(j + 1);
    if (!srcTok || srcTok.type !== "string") return null;
    const source = stringTokenValue(code, srcTok);
    if (source === null) return null;
    let end = srcTok.end;
    j += 2;
    // Import attributes: `with { type: "json" }` — skip the object.
    if (isIdent(j, "with") || isIdent(j, "assert")) {
      if (!isPunct(j + 1, "{")) return null;
      let k = j + 2;
      while (at(k) && !isPunct(k, "}")) k++;
      if (!at(k)) return null;
      end = (at(k) as Token).end;
      j = k + 1;
    }
    if (isPunct(j, ";")) end = (at(j) as Token).end;
    decls.push({ source, bindings: typeOnly ? [] : bindings, start: tok.start, end });
    i = j;
  }
  return decls;
}

// ── Shared module scan ──────────────────────────────────────────────────────

export interface ModuleScan {
  tokens: Token[];
  imports: ImportDecl[];
}

const SCAN_CACHE_SIZE = 4;
const scanCache = new Map<string, ModuleScan | null>();

/**
 * Tokens and imports of a module, or `null` when it cannot be scanned with
 * confidence. Memoized per exact source text: the Vite plugin runs up to four
 * analyses (pure annotations, dev helpers, template compilation, static
 * optimization) over the SAME original source — every transform now emits
 * edits against the original instead of rewriting it step by step — so the
 * module is lexed once instead of once per step. A different source string
 * (a later build of an edited file) is a different key and is scanned afresh.
 */
export function scanModule(code: string): ModuleScan | null {
  const hit = scanCache.get(code);
  if (hit !== undefined) return hit;
  const tokens = tokenize(code);
  const imports = tokens && collectImports(code, tokens);
  const scan = tokens && imports ? { tokens, imports } : null;
  if (scanCache.size >= SCAN_CACHE_SIZE) scanCache.delete(scanCache.keys().next().value as string);
  scanCache.set(code, scan);
  return scan;
}

/** Is `source` the sibujs package or one of its subpath entries? */
export function isSibuSource(source: string): boolean {
  return source === "sibujs" || source.startsWith("sibujs/");
}

/**
 * Local names bound to sibujs exports: local name → exported name.
 * `mainOnly` restricts to the package root (where the tag factories live).
 */
export function sibuBindings(imports: ImportDecl[], mainOnly = false): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of imports) {
    if (mainOnly ? decl.source !== "sibujs" : !isSibuSource(decl.source)) continue;
    for (const b of decl.bindings) {
      if (b.imported === "*" || b.imported === "default") continue;
      out.set(b.local, b.imported);
    }
  }
  return out;
}

// ── Reference walking ───────────────────────────────────────────────────────

export interface IdentRef {
  tok: Extract<Token, { type: "ident" }>;
  list: Token[];
  index: number;
}

/**
 * Visit every identifier token (recursively through template expressions)
 * that is NOT a property name after `.` / `?.`, not a private name after `#`,
 * and not inside an import declaration. Those are the only positions where a
 * local binding can be referenced — or shadowed.
 */
export function forEachBindingRef(tokens: Token[], imports: ImportDecl[], visit: (ref: IdentRef) => void): void {
  const inImport = (offset: number) => imports.some((d) => offset >= d.start && offset < d.end);
  const walk = (list: Token[]) => {
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (tok.type === "template") {
        for (const e of tok.exprs) walk(e.tokens);
        continue;
      }
      if (tok.type !== "ident") continue;
      const prev = list[i - 1];
      // `this.#context()` calls a private method, never the imported binding.
      if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?." || prev.value === "#")) continue;
      if (inImport(tok.start)) continue;
      visit({ tok, list, index: i });
    }
  };
  walk(tokens);
}

// Keywords after which `name(` is an expression — a call — rather than part
// of a declaration. Any other identifier directly before `name(` on the same
// line (`get`, `set`, `async`, `static`, an unknown modifier) is a member
// declaration or something this scanner does not understand.
const EXPRESSION_KEYWORDS = new Set([...REGEX_AFTER_KEYWORD, "default", "extends"]);

function isLineTerminator(c: number): boolean {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

function lineBreakBetween(code: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (isLineTerminator(code.charCodeAt(i))) return true;
  return false;
}

/** Does this token end a value (so a following `*` multiplies)? */
function endsValue(tok: Token | undefined): boolean {
  if (!tok) return false;
  switch (tok.type) {
    case "number":
    case "string":
    case "regex":
    case "template":
      return true;
    case "ident":
      return !EXPRESSION_KEYWORDS.has(tok.value);
    case "punct":
      return tok.value === ")" || tok.value === "]";
  }
}

/**
 * Is `list[index](…)` the head of a DECLARATION rather than a call?
 *
 *   function context(k) {}      function* context() {}   async function context() {}
 *   { context(k) {} }           class A { context() {} } *context() {}
 *   get context() {}            set context(v) {}        async context() {}
 *   abstract context(): void;   context(k: string): void;   (TS signatures)
 *
 * A declaration binds the name in its scope, so the import is shadowed there
 * and a "call" of it is not a call of the sibujs export. When the shape is
 * ambiguous the answer is `true`: the caller then leaves the name alone.
 */
function isDeclarationHead(code: string, list: Token[], index: number): boolean {
  const tok = list[index];
  const prev = list[index - 1];
  if (prev?.type === "ident") {
    if (prev.value === "function") return true;
    // Two juxtaposed identifiers on one line are a modifier + member name
    // (`get x(`, `static x(`) or a shape we do not know. Across a line break
    // they are two statements joined by ASI, and `name(` starts a call.
    if (!EXPRESSION_KEYWORDS.has(prev.value) && !lineBreakBetween(code, prev.end, tok.start)) return true;
  } else if (prev?.type === "punct") {
    // `*name(` is a generator unless the `*` multiplies a value (`a * name(1)`);
    // `yield* name(1)` delegates to a call.
    const before = list[index - 2];
    if (prev.value === "*" && !endsValue(before) && !(before?.type === "ident" && before.value === "yield"))
      return true;
    if (prev.value === "@") return true; // decorator — not worth proving
  }

  // Find the `)` closing this argument list.
  let depth = 0;
  let close = -1;
  for (let k = index + 1; k < list.length; k++) {
    const t = list[k];
    if (t.type !== "punct") continue;
    if (t.value === "(") depth++;
    else if (t.value === ")" && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close === -1) return true;
  const after = list[close + 1];
  if (after?.type !== "punct") return false;
  // `name(…) {` — a call is never followed by a block; a method or function is.
  if (after.value === "{") return true;
  // `name(…): T` — a TypeScript return type, unless the call sits where a
  // colon can follow an expression (`c ? name(1) : x`, `case name(1):`).
  if (after.value === ":") {
    if (!prev) return true;
    if (prev.type === "punct") return ["{", "}", ";", ",", "*"].includes(prev.value);
    return prev.type === "ident" && !EXPRESSION_KEYWORDS.has(prev.value);
  }
  return false;
}

export interface BindingUses {
  /** Direct calls `name(…)` of names that are not shadowed. */
  calls: IdentRef[];
  /** Tagged templates `name\`…\`` of names that are not shadowed. */
  tagged: IdentRef[];
  /**
   * Names that are, or may be, declared or rebound somewhere in the file.
   * Every transform must leave all uses of these names alone.
   */
  shadowed: Set<string>;
}

/**
 * Classify every reference to `names` (local names of sibujs imports).
 *
 * This scanner does not track scopes, so shadowing is decided per FILE: a
 * name counts as shadowed if it is declared anywhere — `function name`,
 * `class name`, a variable, parameter or catch binding (including
 * destructuring and arrow parameters), a second import binding, an object or
 * class method `name() {}` / `get name()` / `async name()` / `*name()` — or
 * used in any position that is neither a call nor a tagged template (passed
 * as a value, assigned, used as a key or label). Any of those can make a
 * `name(…)` somewhere in the file refer to something other than the import,
 * and a pure annotation or a static rewrite of it would change behavior.
 */
export function bindingUses(code: string, scan: ModuleScan, names: ReadonlySet<string>): BindingUses {
  const shadowed = new Set<string>();
  const bound = new Map<string, number>();
  for (const decl of scan.imports) {
    for (const b of decl.bindings) bound.set(b.local, (bound.get(b.local) ?? 0) + 1);
  }
  for (const name of names) if ((bound.get(name) ?? 0) > 1) shadowed.add(name);

  const calls: IdentRef[] = [];
  const tagged: IdentRef[] = [];
  forEachBindingRef(scan.tokens, scan.imports, (ref) => {
    const { tok, list, index } = ref;
    if (!names.has(tok.value)) return;
    const next = list[index + 1];
    if (next && next.type === "punct" && next.value === "(") {
      if (isDeclarationHead(code, list, index)) shadowed.add(tok.value);
      else calls.push(ref);
    } else if (next && next.type === "template") {
      const prev = list[index - 1];
      if (prev?.type === "punct" && prev.value === "@") shadowed.add(tok.value);
      else tagged.push(ref);
    } else {
      shadowed.add(tok.value);
    }
  });
  return {
    calls: calls.filter((r) => !shadowed.has(r.tok.value)),
    tagged: tagged.filter((r) => !shadowed.has(r.tok.value)),
    shadowed,
  };
}

/**
 * Pick an identifier prefix that does not occur anywhere in `code`, so
 * injected bindings can never collide with (or be shadowed by) user code.
 */
export function uniquePrefix(code: string, base = "__sibujs"): string {
  let prefix = `${base}$`;
  for (let n = 1; code.includes(prefix); n++) prefix = `${base}${n}$`;
  return prefix;
}

// ── Pure annotations ────────────────────────────────────────────────────────

/**
 * SibuJS factories whose call result can be dropped when unused. Only calls to
 * these names AS IMPORTED FROM SIBUJS are annotated.
 */
export const PURE_FACTORIES = new Set([
  "tagFactory",
  "context",
  "defineComponent",
  "withProps",
  "withDefaults",
  "pure",
  "noSideEffect",
]);

const PURE_COMMENT = "/*#__PURE__*/ ";

/**
 * The insertions that put `/*#__PURE__*\/` before calls to side-effect-free
 * sibujs factories, as edits against `code`.
 *
 * A pure annotation licenses the minifier to DELETE the call when its result is
 * unused, so a wrong annotation silently removes user code. It is therefore
 * applied only to identifiers bound by an import from sibujs, only at direct
 * call sites, and not at all for a name the file may shadow anywhere (see
 * `bindingUses`) — this scanner does not track scopes.
 */
export function pureAnnotationEdits(code: string): SourceEdit[] {
  if (!code.includes("sibujs")) return [];
  const scan = scanModule(code);
  if (!scan) return [];
  const candidates = new Set<string>();
  for (const [local, imported] of sibuBindings(scan.imports)) if (PURE_FACTORIES.has(imported)) candidates.add(local);
  if (candidates.size === 0) return [];

  const uses = bindingUses(code, scan, candidates);
  // A factory used as a template tag is used in a way we do not annotate.
  const unsafe = new Set(uses.shadowed);
  for (const ref of uses.tagged) unsafe.add(ref.tok.value);

  return uses.calls
    .filter(({ tok }) => {
      if (unsafe.has(tok.value)) return false;
      // Already annotated (by the author or a previous pass).
      return !/\/\*\s*[#@]__PURE__\s*\*\/\s*$/.test(code.slice(Math.max(0, tok.start - 40), tok.start));
    })
    .map(({ tok }) => ({ start: tok.start, end: tok.start, text: PURE_COMMENT }));
}

/** `code` with pure annotations inserted (see `pureAnnotationEdits`). */
export function injectPureAnnotations(code: string): string {
  const edits = normalizeEdits(pureAnnotationEdits(code));
  return edits && edits.length > 0 ? applyEdits(code, edits) : code;
}

/** Does this module import anything from sibujs (at runtime)? */
export function importsSibu(code: string): boolean {
  if (!code.includes("sibujs")) return false;
  const scan = scanModule(code);
  return !!scan?.imports.some((d) => isSibuSource(d.source));
}
