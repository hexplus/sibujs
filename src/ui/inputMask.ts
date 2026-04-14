import { signal } from "../core/signals/signal";

// ============================================================================
// INPUT MASKING
// ============================================================================

export interface MaskOptions {
  /** Pattern: 9 = digit, A = letter, * = any, other chars are literals */
  pattern: string;
  /** Placeholder character for unfilled positions */
  placeholder?: string;
}

/**
 * inputMask applies a mask to an input element.
 * Returns reactive value and ref binding.
 */
export function inputMask(options: MaskOptions): {
  value: () => string;
  rawValue: () => string;
  bind: (input: HTMLInputElement) => () => void;
} {
  const placeholder = options.placeholder || "_";
  const [value, setValue] = signal("");
  const [rawValue, setRawValue] = signal("");

  function applyMask(raw: string): string {
    let result = "";
    let rawIndex = 0;

    for (let i = 0; i < options.pattern.length && rawIndex < raw.length; i++) {
      const maskChar = options.pattern[i];

      if (maskChar === "9") {
        // Digit only
        while (rawIndex < raw.length && !/\d/.test(raw[rawIndex])) rawIndex++;
        if (rawIndex < raw.length) {
          result += raw[rawIndex++];
        }
      } else if (maskChar === "A") {
        // Letter only
        while (rawIndex < raw.length && !/[a-zA-Z]/.test(raw[rawIndex])) rawIndex++;
        if (rawIndex < raw.length) {
          result += raw[rawIndex++];
        }
      } else if (maskChar === "*") {
        // Any character
        result += raw[rawIndex++];
      } else {
        // Literal character from pattern
        result += maskChar;
        if (raw[rawIndex] === maskChar) rawIndex++;
      }
    }

    return result;
  }

  function extractRaw(masked: string): string {
    let raw = "";
    for (let i = 0; i < masked.length && i < options.pattern.length; i++) {
      const maskChar = options.pattern[i];
      if (maskChar === "9" || maskChar === "A" || maskChar === "*") {
        raw += masked[i];
      }
    }
    return raw;
  }

  function isSlot(c: string): boolean {
    return c === "9" || c === "A" || c === "*";
  }

  // Build strip regex based on mask slots:
  // - Pattern has only 9 → keep digits only
  // - Pattern has only A → keep letters only
  // - Pattern has * → keep all chars (only strip literal chars from the mask)
  function buildStripRegex(): RegExp {
    const hasDigit = options.pattern.includes("9");
    const hasLetter = options.pattern.includes("A");
    const hasAny = options.pattern.includes("*");
    if (hasAny) {
      // Collect literal chars from the pattern to strip (they're auto-inserted by applyMask)
      const literals = new Set<string>();
      for (const c of options.pattern) {
        if (!isSlot(c)) literals.add(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
      return literals.size > 0 ? new RegExp(`[${Array.from(literals).join("")}]`, "g") : /(?!)/g;
    }
    if (hasDigit && hasLetter) return /[^a-zA-Z0-9]/g;
    if (hasDigit) return /[^0-9]/g;
    if (hasLetter) return /[^a-zA-Z]/g;
    return /[^a-zA-Z0-9]/g;
  }
  const stripRegex = buildStripRegex();
  const rawCharTest = options.pattern.includes("*") ? () => true : (c: string) => /[a-zA-Z0-9]/.test(c);

  function bind(input: HTMLInputElement): () => void {
    const onInput = () => {
      const cursorBefore = input.selectionStart ?? input.value.length;
      const oldValue = input.value;
      const raw = oldValue.replace(stripRegex, "");
      const masked = applyMask(raw);
      setValue(masked);
      setRawValue(extractRaw(masked));
      input.value = masked;

      let rawBefore = 0;
      for (let i = 0; i < cursorBefore && i < oldValue.length; i++) {
        if (rawCharTest(oldValue[i])) rawBefore++;
      }
      let newCursor = 0;
      let counted = 0;
      for (; newCursor < masked.length; newCursor++) {
        if (newCursor < options.pattern.length && isSlot(options.pattern[newCursor])) {
          counted++;
          if (counted >= rawBefore) {
            newCursor++;
            break;
          }
        }
      }
      input.setSelectionRange(newCursor, newCursor);
    };

    const onFocus = () => {
      if (!input.value) {
        const display = options.pattern
          .replace(/9/g, placeholder)
          .replace(/A/g, placeholder)
          .replace(/\*/g, placeholder);
        input.placeholder = display;
      }
    };

    input.addEventListener("input", onInput);
    input.addEventListener("focus", onFocus);

    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
    };
  }

  return { value, rawValue, bind };
}

// ============================================================================
// PRESET MASKS
// ============================================================================

/** Phone number mask: (999) 999-9999 */
export function phoneMask(): MaskOptions {
  return { pattern: "(999) 999-9999" };
}

/** Date mask: 99/99/9999 */
export function dateMask(): MaskOptions {
  return { pattern: "99/99/9999" };
}

/** Credit card mask: 9999 9999 9999 9999 */
export function creditCardMask(): MaskOptions {
  return { pattern: "9999 9999 9999 9999" };
}

/** Time mask: 99:99 */
export function timeMask(): MaskOptions {
  return { pattern: "99:99" };
}

/** SSN mask: 999-99-9999 */
export function ssnMask(): MaskOptions {
  return { pattern: "999-99-9999" };
}

/** ZIP code mask: 99999 */
export function zipMask(): MaskOptions {
  return { pattern: "99999" };
}
