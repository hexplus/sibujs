/**
 * ESLint plugin configuration for SibuJS best practices.
 * Provides rule definitions that can be used with an ESLint plugin.
 */

export interface LintViolation {
  rule: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
  column?: number;
}

/**
 * Get the line number for a given character index in source code.
 */
function getLineNumber(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Get the column number for a given character index in source code.
 */
function getColumnNumber(source: string, index: number): number {
  let col = 1;
  for (let i = index - 1; i >= 0; i--) {
    if (source[i] === "\n") break;
    col++;
  }
  return col;
}

/**
 * Static analysis rules for SibuJS code.
 * These check source code strings for common mistakes and anti-patterns.
 */
export const lintRules = {
  /** Detect signal inside loops or conditionals */
  "no-signals-in-conditionals": {
    name: "no-signals-in-conditionals" as const,
    description: "Signal functions should not be called inside conditionals, loops, or nested functions",
    check(source: string): LintViolation[] {
      const violations: LintViolation[] = [];
      const hookNames = ["signal", "effect", "derived", "memo", "memoFn", "ref", "watch", "store"];
      const hookPattern = new RegExp(`\\b(${hookNames.join("|")})\\s*\\(`, "g");
      const lines = source.split("\n");

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trim();

        // Skip import lines
        if (trimmed.startsWith("import ")) continue;

        // Check if this line contains a signal function call
        hookPattern.lastIndex = 0;
        const hookMatch = hookPattern.exec(line);
        if (!hookMatch) continue;

        const hookName = hookMatch[1];

        // Determine nesting context by scanning preceding lines for
        // unclosed if/for/while/switch blocks or nested functions
        let braceDepth = 0;
        let insideConditionalOrLoop = false;
        let insideNestedFunction = false;
        let functionDepth = 0;

        // Scan from the start of the source up to this line
        for (let i = 0; i <= lineIdx; i++) {
          const scanLine = lines[i].trim();

          // Track function declarations (depth > 0 means nested)
          if (/\b(function\s+\w+|function\s*\(|=>\s*\{)/.test(scanLine) && i < lineIdx) {
            functionDepth++;
          }

          // Track conditional/loop keywords at the current brace depth
          if (i < lineIdx && /^\s*(if|else\s+if|else|for|while|do|switch)\s*[({]/.test(lines[i])) {
            // Mark that we entered a conditional/loop block
            insideConditionalOrLoop = true;
          }

          // Track braces for scope
          for (const ch of lines[i]) {
            if (ch === "{") braceDepth++;
            if (ch === "}") {
              braceDepth--;
              if (braceDepth <= 1) {
                insideConditionalOrLoop = false;
              }
            }
          }
        }

        // Detect signal functions inside inline conditionals (same line)
        const beforeHook = line.substring(0, line.indexOf(hookMatch[0]));
        const inlineConditional =
          /\b(if|else|for|while|switch)\s*\(/.test(beforeHook) || /\?\s*$/.test(beforeHook.trim());

        if (insideConditionalOrLoop || inlineConditional) {
          violations.push({
            rule: "no-signals-in-conditionals",
            message: `"${hookName}" should not be called inside a conditional or loop. Signal functions must be called at the top level of a component.`,
            severity: "error",
            line: lineIdx + 1,
            column: (hookMatch.index || 0) + 1,
          });
        }

        // Detect signal functions in deeply nested functions (arrow functions / callbacks)
        if (functionDepth > 1) {
          insideNestedFunction = true;
        }

        if (insideNestedFunction) {
          violations.push({
            rule: "no-signals-in-conditionals",
            message: `"${hookName}" should not be called inside a nested function. Signal functions must be called at the top level of a component.`,
            severity: "error",
            line: lineIdx + 1,
            column: (hookMatch.index || 0) + 1,
          });
        }
      }

      return violations;
    },
  },

  /** Detect missing cleanup in effect */
  "effect-cleanup": {
    name: "effect-cleanup" as const,
    description: "effect with subscriptions or timers should return a cleanup function",
    check(source: string): LintViolation[] {
      const violations: LintViolation[] = [];
      // Patterns that indicate a subscription or timer that needs cleanup
      const subscriptionPatterns = [
        "addEventListener",
        "setTimeout",
        "setInterval",
        "requestAnimationFrame",
        "subscribe",
        "observe",
        "WebSocket",
        "EventSource",
      ];

      // Find effect calls and analyze their bodies
      const effectRegex = /\beffect\s*\(\s*((?:function\s*\(?\)?\s*\{|\(\s*\)\s*=>\s*\{|(?=\(\))))/g;
      let match: RegExpExecArray | null;

      while ((match = effectRegex.exec(source)) !== null) {
        const startIndex = match.index;
        const line = getLineNumber(source, startIndex);
        const column = getColumnNumber(source, startIndex);

        // Extract the effect body by matching braces
        const bodyStart = source.indexOf("{", match.index + match[0].length - 1);
        if (bodyStart === -1) continue;

        let depth = 0;
        let bodyEnd = bodyStart;
        for (let i = bodyStart; i < source.length; i++) {
          if (source[i] === "{") depth++;
          if (source[i] === "}") {
            depth--;
            if (depth === 0) {
              bodyEnd = i;
              break;
            }
          }
        }

        const effectBody = source.substring(bodyStart, bodyEnd + 1);

        // Check if the body contains subscription/timer patterns
        const hasSubscription = subscriptionPatterns.some((p) => effectBody.includes(p));

        if (hasSubscription) {
          // Check if there's a corresponding cleanup pattern
          const hasRemoveListener = effectBody.includes("removeEventListener");
          const hasClearTimeout = effectBody.includes("clearTimeout");
          const hasClearInterval = effectBody.includes("clearInterval");
          const hasCancelRAF = effectBody.includes("cancelAnimationFrame");
          const hasUnsubscribe =
            effectBody.includes("unsubscribe") || effectBody.includes("disconnect") || effectBody.includes(".close(");
          const hasReturnCleanup = /return\s+/.test(effectBody);

          const hasCleanup =
            hasRemoveListener ||
            hasClearTimeout ||
            hasClearInterval ||
            hasCancelRAF ||
            hasUnsubscribe ||
            hasReturnCleanup;

          if (!hasCleanup) {
            // Identify which subscription was found without cleanup
            const foundSubscriptions: string[] = [];
            for (const pattern of subscriptionPatterns) {
              if (effectBody.includes(pattern)) {
                foundSubscriptions.push(pattern);
              }
            }

            violations.push({
              rule: "effect-cleanup",
              message: `effect uses ${foundSubscriptions.join(", ")} but does not appear to clean up. Consider returning a cleanup function.`,
              severity: "warning",
              line,
              column,
            });
          }
        }
      }

      return violations;
    },
  },

  /** Detect direct DOM mutation outside of reactive context */
  "no-direct-dom-mutation": {
    name: "no-direct-dom-mutation" as const,
    description: "Avoid direct DOM mutations; use reactive bindings instead",
    check(source: string): LintViolation[] {
      const violations: LintViolation[] = [];

      // DOM mutation patterns to detect
      const mutationPatterns = [
        {
          pattern: /\.innerHTML\s*=/g,
          name: "innerHTML assignment",
          suggestion: "Use reactive nodes or bindChildNode instead",
        },
        {
          pattern: /\.outerHTML\s*=/g,
          name: "outerHTML assignment",
          suggestion: "Use reactive component rendering instead",
        },
        {
          pattern: /document\.write\s*\(/g,
          name: "document.write()",
          suggestion: "Use mount() or component rendering instead",
        },
        {
          pattern: /\.insertAdjacentHTML\s*\(/g,
          name: "insertAdjacentHTML()",
          suggestion: "Use reactive nodes or each() instead",
        },
      ];

      const lines = source.split("\n");

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Support inline disable: // sibujs-disable-next-line no-direct-dom-mutation
        if (lineIdx > 0) {
          const prevTrimmed = lines[lineIdx - 1].trim();
          if (
            prevTrimmed.includes("sibujs-disable-next-line") &&
            (prevTrimmed.includes("no-direct-dom-mutation") ||
              !prevTrimmed.includes(" ", prevTrimmed.indexOf("sibujs-disable-next-line") + 25))
          ) {
            continue;
          }
        }

        // Support inline disable on same line: // sibujs-disable no-direct-dom-mutation
        if (line.includes("sibujs-disable") && !line.includes("sibujs-disable-next-line")) continue;

        for (const { pattern, name, suggestion } of mutationPatterns) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match) {
            violations.push({
              rule: "no-direct-dom-mutation",
              message: `Direct DOM mutation via ${name} detected. ${suggestion}.`,
              severity: "warning",
              line: lineIdx + 1,
              column: (match.index || 0) + 1,
            });
          }
        }
      }

      return violations;
    },
  },

  /** Detect missing key prop in each() calls */
  "each-requires-key": {
    name: "each-requires-key" as const,
    description: "each() should include a key function for efficient reconciliation",
    check(source: string): LintViolation[] {
      const violations: LintViolation[] = [];

      // Match each() calls and check if they have a key option
      // each(getter, render) - missing key (only 2 args, no options object)
      // each(getter, render, { key: ... }) - correct
      const eachCallRegex = /\beach\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = eachCallRegex.exec(source)) !== null) {
        const startIndex = match.index;
        const line = getLineNumber(source, startIndex);
        const column = getColumnNumber(source, startIndex);

        // Extract the full call by matching parentheses
        const parenStart = source.indexOf("(", startIndex);
        if (parenStart === -1) continue;

        let depth = 0;
        let parenEnd = parenStart;
        for (let i = parenStart; i < source.length; i++) {
          if (source[i] === "(") depth++;
          if (source[i] === ")") {
            depth--;
            if (depth === 0) {
              parenEnd = i;
              break;
            }
          }
        }

        const callBody = source.substring(parenStart, parenEnd + 1);

        // Check if the call includes a key property
        const hasKey = /\bkey\s*:/.test(callBody);

        if (!hasKey) {
          violations.push({
            rule: "each-requires-key",
            message:
              "each() should include a key function in the options argument (e.g., { key: item => item.id }) for efficient list reconciliation.",
            severity: "warning",
            line,
            column,
          });
        }
      }

      return violations;
    },
  },

  /** Detect unused reactive state */
  "no-unused-state": {
    name: "no-unused-state" as const,
    description: "signal variables should be used in the component",
    check(source: string): LintViolation[] {
      const violations: LintViolation[] = [];

      // Match signal destructuring: const [getter, setter] = signal(...)
      const signalDeclRegex = /\bconst\s+\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*signal\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = signalDeclRegex.exec(source)) !== null) {
        const getterName = match[1];
        const setterName = match[2];
        const line = getLineNumber(source, match.index);
        const column = getColumnNumber(source, match.index);

        // Check if getter is used elsewhere in the source (excluding the declaration line)
        const declarationLine = source.substring(match.index, source.indexOf("\n", match.index));
        const restOfSource = source.replace(declarationLine, "");

        // Create regex to find usages of the getter (as a function call or reference)
        const getterUsageRegex = new RegExp(`\\b${escapeRegex(getterName)}\\b`, "g");
        const getterUsages = restOfSource.match(getterUsageRegex);
        const getterUsed = getterUsages !== null && getterUsages.length > 0;

        // Check setter usage
        const setterUsageRegex = new RegExp(`\\b${escapeRegex(setterName)}\\b`, "g");
        const setterUsages = restOfSource.match(setterUsageRegex);
        const setterUsed = setterUsages !== null && setterUsages.length > 0;

        if (!getterUsed && !setterUsed) {
          violations.push({
            rule: "no-unused-state",
            message: `signal variable "${getterName}" and setter "${setterName}" are declared but never used. Remove unused state or use the values.`,
            severity: "warning",
            line,
            column,
          });
        } else if (!getterUsed) {
          violations.push({
            rule: "no-unused-state",
            message: `signal getter "${getterName}" is declared but never read. If the value is not needed, consider using a simple variable instead of reactive state.`,
            severity: "warning",
            line,
            column,
          });
        } else if (!setterUsed) {
          violations.push({
            rule: "no-unused-state",
            message: `signal setter "${setterName}" is declared but never called. If the state never changes, consider using a plain constant instead.`,
            severity: "warning",
            line,
            column,
          });
        }
      }

      return violations;
    },
  },
};

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run all lint rules on source code.
 */
export function lintSource(source: string, rules?: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  const ruleEntries = Object.entries(lintRules) as [
    string,
    { name: string; check: (source: string) => LintViolation[] },
  ][];

  for (const [ruleName, rule] of ruleEntries) {
    // If specific rules are requested, only run those
    if (rules && rules.length > 0 && !rules.includes(ruleName)) {
      continue;
    }
    const ruleViolations = rule.check(source);
    violations.push(...ruleViolations);
  }

  // Sort violations by line number, then column
  violations.sort((a, b) => {
    const lineDiff = (a.line || 0) - (b.line || 0);
    if (lineDiff !== 0) return lineDiff;
    return (a.column || 0) - (b.column || 0);
  });

  return violations;
}

/**
 * Generate ESLint plugin configuration.
 * Returns a config object that can be used in .eslintrc.
 */
export function generateEslintConfig(options?: { severity?: "error" | "warning" }): Record<string, unknown> {
  const severity = options?.severity || "warning";
  const rulePrefix = "sibujs";

  // Build rules configuration
  const rulesConfig: Record<string, string> = {};
  for (const ruleName of Object.keys(lintRules)) {
    rulesConfig[`${rulePrefix}/${ruleName}`] = severity;
  }

  return {
    plugins: [rulePrefix],
    rules: rulesConfig,
    settings: {
      sibujs: {
        version: "detect",
      },
    },
    overrides: [
      {
        files: ["*.ts", "*.tsx", "*.js", "*.jsx"],
        rules: rulesConfig,
      },
    ],
  };
}
