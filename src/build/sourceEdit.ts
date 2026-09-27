/**
 * Offset-based source edits and the source map that describes them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The build transforms used to rewrite a module step by step, each step
 * producing a new string, and returned no source map. The dev prologue added
 * two lines at the top of every sibujs module, so every stack trace and
 * breakpoint in development was two lines off, and Rollup warned that the
 * source map was likely incorrect. Pure annotations and compiled templates
 * shifted columns (and templates collapsed lines) with nothing to map them
 * back.
 *
 * Now every transform describes its change as edits against the ORIGINAL
 * source, all edits are applied in one pass, and the map below is generated
 * from the same edit list. The transforms keep every line where it was:
 * replacements carry the line breaks of the text they replace, the dev
 * prologue sits on the first line, and generated helpers are appended after
 * the last original line. The map is therefore line-exact by construction,
 * and column-exact at every identifier of unchanged code.
 *
 * Internal to the build tooling; not re-exported from `sibujs/build`.
 */

export interface SourceEdit {
  /** Offset of the first replaced character in the original source. */
  start: number;
  /** Offset just past the replaced range (`start` for a pure insertion). */
  end: number;
  /** Replacement text. */
  text: string;
}

/** A version 3 source map, as bundlers accept it from a transform hook. */
export interface SourceMapV3 {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

function isLineBreak(c: number): boolean {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/**
 * The line terminators of `code[start, end)`, verbatim and in order. Appending
 * them to a replacement keeps every following line at its original number —
 * for bundler tooling (which counts `\n`) and for engines (which also count
 * CR and the Unicode line/paragraph separators) alike.
 */
export function lineBreaksIn(code: string, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    if (isLineBreak(code.charCodeAt(i))) out += code[i];
  }
  return out;
}

/** Is there a line terminator (or a comment containing one) between two offsets? */
export function hasLineBreak(code: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (isLineBreak(code.charCodeAt(i))) return true;
  }
  return false;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * `JSON.stringify` as a JavaScript string literal, with U+2028/U+2029 escaped.
 * Both are legal inside a string literal, but engines count them as line
 * terminators, so a raw one in generated code would shift every later line.
 */
export function jsStringLiteral(value: string): string {
  const json = JSON.stringify(value);
  if (!json.includes(LINE_SEPARATOR) && !json.includes(PARAGRAPH_SEPARATOR)) return json;
  const bs = "\\";
  return json.split(LINE_SEPARATOR).join(`${bs}u2028`).split(PARAGRAPH_SEPARATOR).join(`${bs}u2029`);
}

/**
 * Sort edits by position (insertions before a replacement at the same offset,
 * otherwise in the order given). Returns `null` if two edits overlap — the
 * transforms never produce that, and a caller seeing it must leave the file
 * untouched rather than guess.
 */
export function normalizeEdits(edits: readonly SourceEdit[]): SourceEdit[] | null {
  const sorted = edits
    .map((edit, order) => ({ edit, order }))
    .sort(
      (a, b) =>
        a.edit.start - b.edit.start || a.edit.end - a.edit.start - (b.edit.end - b.edit.start) || a.order - b.order,
    )
    .map((x) => x.edit);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) return null;
  }
  return sorted;
}

/** Apply normalized (sorted, non-overlapping) edits, then append `append`. */
export function applyEdits(code: string, edits: readonly SourceEdit[], append = ""): string {
  let out = "";
  let pos = 0;
  for (const edit of edits) {
    out += code.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return out + code.slice(pos) + append;
}

// ── Source map ──────────────────────────────────────────────────────────────

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += BASE64[digit];
  } while (v > 0);
  return out;
}

function isWordStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127 || (c >= 48 && c <= 57);
}

/**
 * Generate the source map for `applyEdits(code, edits, append)`.
 *
 * Unchanged code gets a segment at the start of every chunk, every line and
 * every word, each pointing at its exact original line and column. Inserted
 * or replacement text maps to the start of the range it replaced (and each of
 * its line breaks to the matching line of that range). Appended text is
 * generated code with no original and stays unmapped.
 *
 * Lines are counted by `\n`, the convention of Rollup, Vite and webpack.
 */
export function editsSourceMap(
  code: string,
  edits: readonly SourceEdit[],
  append: string,
  source: string,
): SourceMapV3 {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const origLine = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Segments per generated line: [generated column, original line, original column].
  const lines: [number, number, number][][] = [[]];
  let col = 0;
  const mark = (offset: number) => {
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last[0] === col) return;
    const ol = origLine(offset);
    line.push([col, ol, offset - lineStarts[ol]]);
  };
  const newline = () => {
    lines.push([]);
    col = 0;
  };

  const emitOriginal = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const c = code.charCodeAt(i);
      if (c === 10) {
        newline();
        continue;
      }
      if (i === from || col === 0 || (isWordStart(c) && !isWordStart(code.charCodeAt(i - 1)))) mark(i);
      col++;
    }
  };

  const emitReplacement = (edit: SourceEdit) => {
    // Line breaks in the replacement correspond, in order, to those of the
    // replaced range; a line of replacement text maps to the start of the
    // matching original line.
    let origOffset = edit.start;
    let pending = true;
    for (let i = 0; i < edit.text.length; i++) {
      if (edit.text.charCodeAt(i) === 10) {
        newline();
        const nl = code.indexOf("\n", origOffset);
        if (nl !== -1 && nl < edit.end) {
          origOffset = nl + 1;
          pending = true;
        } else {
          pending = false; // no original line to point at
        }
        continue;
      }
      if (pending) {
        mark(origOffset);
        pending = false;
      }
      col++;
    }
  };

  let pos = 0;
  for (const edit of edits) {
    emitOriginal(pos, edit.start);
    emitReplacement(edit);
    pos = edit.end;
  }
  emitOriginal(pos, code.length);
  for (let i = 0; i < append.length; i++) {
    if (append.charCodeAt(i) === 10) newline();
  }

  let prevLine = 0;
  let prevCol = 0;
  let prevSource = 0;
  const mappings = lines
    .map((segments) => {
      let prevGen = 0;
      return segments
        .map(([gen, ol, oc]) => {
          const s = vlq(gen - prevGen) + vlq(0 - prevSource) + vlq(ol - prevLine) + vlq(oc - prevCol);
          prevGen = gen;
          prevSource = 0;
          prevLine = ol;
          prevCol = oc;
          return s;
        })
        .join(",");
    })
    .join(";");

  return { version: 3, sources: [source], sourcesContent: [code], names: [], mappings };
}
