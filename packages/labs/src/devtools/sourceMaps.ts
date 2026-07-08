/**
 * Source map and debugging utilities for SibuJS.
 * Provides enhanced error reporting with component context and stack traces.
 *
 * These utilities do not parse `.map` files at runtime; instead they enrich
 * errors with SibuJS-specific component context so that developers can quickly
 * identify *which* component failed and *what* props were in play, regardless
 * of whether source maps are available in the browser.
 */

// ---------------------------------------------------------------------------
// SibuError
// ---------------------------------------------------------------------------

/**
 * Enhanced error class with component context.
 *
 * Extends the native `Error` to carry the component name and the props that
 * were active when the error was thrown.  The `cause` property (ES2022) is
 * also forwarded so that the original error is preserved.
 *
 * @example
 * ```ts
 * throw new SibuError("Render failed", {
 *   component: "UserCard",
 *   props: { userId: 42 },
 *   cause: originalError,
 * });
 * ```
 */
export class SibuError extends Error {
  component?: string;
  props?: Record<string, unknown>;

  constructor(message: string, options?: { component?: string; props?: Record<string, unknown>; cause?: Error }) {
    super(message);
    // Attach cause manually (ES2022 feature, not in ES2020 lib)
    if (options?.cause) {
      (this as unknown as { cause: Error }).cause = options.cause;
    }

    this.name = "SibuError";
    this.component = options?.component;
    this.props = options?.props;

    // Maintain correct prototype chain for instanceof checks
    Object.setPrototypeOf(this, SibuError.prototype);
  }
}

// ---------------------------------------------------------------------------
// createErrorReporter
// ---------------------------------------------------------------------------

/**
 * Create a component error reporter that captures stack traces and maps them
 * to component context.
 *
 * The reporter collects errors into an internal list, optionally logs them
 * to the console, and forwards them to a user-supplied `onError` handler.
 *
 * @param options Configuration options
 * @returns Reporter API
 *
 * @example
 * ```ts
 * const reporter = createErrorReporter({
 *   onError: (err) => analytics.track("component_error", err),
 *   logToConsole: true,
 *   maxErrors: 200,
 * });
 *
 * reporter.report(new Error("oops"), { component: "Dashboard" });
 * console.log(reporter.getErrors());
 * ```
 */
export function createErrorReporter(options?: {
  /** Custom error handler */
  onError?: (error: SibuError) => void;
  /** Whether to log to console (default `true`) */
  logToConsole?: boolean;
  /** Max errors to retain */
  maxErrors?: number;
}): {
  /** Report an error with component context */
  report: (error: Error, context?: { component?: string; props?: Record<string, unknown> }) => void;
  /** Get all reported errors */
  getErrors: () => SibuError[];
  /** Clear error history */
  clear: () => void;
  /** Get error count by component */
  getErrorsByComponent: () => Map<string, SibuError[]>;
} {
  const logToConsole = options?.logToConsole ?? true;
  const maxErrors = options?.maxErrors ?? 500;
  const errors: SibuError[] = [];

  function report(error: Error, context?: { component?: string; props?: Record<string, unknown> }): void {
    // Wrap into a SibuError if not already one
    let sibuError: SibuError;
    if (error instanceof SibuError) {
      sibuError = error;
      // Merge context if provided
      if (context?.component && !sibuError.component) {
        sibuError.component = context.component;
      }
      if (context?.props && !sibuError.props) {
        sibuError.props = context.props;
      }
    } else {
      sibuError = new SibuError(error.message, {
        component: context?.component,
        props: context?.props,
        cause: error,
      });
      // Copy the original stack so the trace points to the actual throw site
      sibuError.stack = error.stack;
    }

    errors.push(sibuError);

    // Trim old errors when the cap is exceeded
    if (errors.length > maxErrors) {
      errors.splice(0, errors.length - maxErrors);
    }

    if (logToConsole) {
      console.error(formatError(sibuError, { component: sibuError.component }));
    }

    if (options?.onError) {
      try {
        options.onError(sibuError);
      } catch {
        // Prevent the handler itself from throwing
      }
    }
  }

  function getErrors(): SibuError[] {
    return errors.slice();
  }

  function clear(): void {
    errors.length = 0;
  }

  function getErrorsByComponent(): Map<string, SibuError[]> {
    const map = new Map<string, SibuError[]>();
    for (const err of errors) {
      const key = err.component ?? "<unknown>";
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(err);
    }
    return map;
  }

  return { report, getErrors, clear, getErrorsByComponent };
}

// ---------------------------------------------------------------------------
// withErrorTracking
// ---------------------------------------------------------------------------

/**
 * Wrap a component factory with error tracking.
 * Catches errors during rendering and reports them via the supplied reporter
 * (or a default one).  If the component throws, a fallback `<div>` with the
 * error message is returned so the rest of the page is not broken.
 *
 * @param name       Human-readable component name
 * @param component  Factory function that returns an `HTMLElement`
 * @param reporter   Optional error reporter (a default is created if omitted)
 * @returns A wrapped factory function with identical signature
 *
 * @example
 * ```ts
 * const SafeWidget = withErrorTracking("Widget", () => Widget(), reporter);
 * document.body.appendChild(SafeWidget());
 * ```
 */
export function withErrorTracking(
  name: string,
  component: () => HTMLElement,
  reporter?: ReturnType<typeof createErrorReporter>,
): () => HTMLElement {
  const rep = reporter ?? createErrorReporter();

  return (): HTMLElement => {
    try {
      return component();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      rep.report(error, { component: name });

      // Return a visible error placeholder so the page does not crash
      const fallback = document.createElement("div");
      fallback.setAttribute("data-sibu-error", name);
      fallback.style.cssText =
        "border:2px solid red;padding:12px;margin:4px;font-family:monospace;color:red;background:#fff0f0;";
      fallback.textContent = `[SibuJS] ${name}: ${error.message}`;
      return fallback;
    }
  };
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * Format an error with enhanced stack trace information.
 * Adds component context markers to stack traces so that the developer can
 * immediately see which SibuJS component is involved.
 *
 * @param error    The error to format
 * @param context  Optional context to include in the formatted output
 * @returns A formatted multi-line string suitable for `console.error`
 *
 * @example
 * ```ts
 * try {
 *   render();
 * } catch (e) {
 *   console.error(formatError(e, { component: "App" }));
 * }
 * ```
 */
export function formatError(
  error: Error,
  context?: { component?: string },
  seen: Set<Error> = new Set([error]),
): string {
  const lines: string[] = [];

  // Header
  const componentLabel = context?.component ?? (error instanceof SibuError ? error.component : undefined);
  if (componentLabel) {
    lines.push(`[SibuJS:${componentLabel}] ${error.name}: ${error.message}`);
  } else {
    lines.push(`[SibuJS] ${error.name}: ${error.message}`);
  }

  // Props snapshot (SibuError only)
  if (error instanceof SibuError && error.props) {
    try {
      lines.push(`  Props: ${JSON.stringify(error.props)}`);
    } catch {
      lines.push("  Props: [unserializable]");
    }
  }

  // Stack trace with component marker
  if (error.stack) {
    const rawStack = error.stack;
    // The stack usually starts with the error message repeated; strip it.
    const stackStart = rawStack.indexOf("\n");
    const stackBody = stackStart !== -1 ? rawStack.slice(stackStart) : rawStack;

    if (componentLabel) {
      lines.push(`  --- in <${componentLabel}> ---`);
    }
    lines.push(stackBody);
  }

  // Original cause (if any). Guard against cyclic cause chains
  // (`a.cause = b; b.cause = a`) which would otherwise overflow the stack
  // while formatting an error.
  const cause = (error as unknown as { cause?: Error }).cause;
  if (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    lines.push("");
    lines.push("Caused by:");
    lines.push(formatError(cause, context, seen));
  }

  return lines.join("\n");
}
