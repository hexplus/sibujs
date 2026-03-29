import { isDev } from "../core/dev";
import { button, div, h3, p, pre, span, style } from "../core/rendering/html";
import { signal } from "../core/signals/signal";

const _isDev = isDev();

export interface ErrorBoundaryProps {
  /**
   * Function that renders child content or throws.
   */
  nodes: () => Element;
  /**
   * Fallback renderer given an Error and retry callback.
   * Memoized internally — only re-created when the error changes.
   */
  fallback?: (error: Error, retry: () => void) => Element;
  /**
   * Called when an error is caught (sync or async).
   */
  onError?: (error: Error) => void;
}

// CSS styles for ErrorBoundary
const errorBoundaryStyles = `
  .sibu-error-boundary {
    position: relative;
  }

  .sibu-error-fallback {
    border: 1px solid #e5484d;
    border-radius: 8px;
    padding: 0;
    margin: 10px 0;
    background: #1a1a2e;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e1e1e6;
    overflow: hidden;
  }

  .sibu-error-fallback .sibu-error-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: #e5484d;
    color: white;
  }

  .sibu-error-fallback .sibu-error-title {
    margin: 0;
    font-size: 0.95em;
    font-weight: 600;
  }

  .sibu-error-fallback .sibu-error-source {
    margin-left: auto;
    font-size: 0.8em;
    opacity: 0.9;
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
  }

  .sibu-error-fallback .sibu-error-body {
    padding: 16px;
  }

  .sibu-error-fallback .sibu-error-message {
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
    margin: 0 0 12px 0;
    color: #f1a9a0;
    word-break: break-word;
    font-size: 0.9em;
    line-height: 1.5;
  }

  .sibu-error-fallback .sibu-error-stack-container {
    position: relative;
    margin: 0 0 12px 0;
    border-radius: 6px;
    border: 1px solid #2a2a3e;
    background: #12121f;
    overflow: hidden;
  }

  .sibu-error-fallback .sibu-error-stack-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #1e1e32;
    border-bottom: 1px solid #2a2a3e;
    font-size: 0.75em;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sibu-error-fallback .sibu-error-copy-btn {
    background: transparent;
    border: 1px solid #3a3a4e;
    border-radius: 4px;
    color: #888;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 1em;
    transition: all 0.15s ease;
  }

  .sibu-error-fallback .sibu-error-copy-btn:hover {
    background: #2a2a3e;
    color: #ccc;
    border-color: #4a4a5e;
  }

  .sibu-error-fallback .sibu-error-stack pre {
    margin: 0;
    padding: 12px;
    overflow-x: auto;
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
    font-size: 0.82em;
    line-height: 1.6;
    color: #a0a0b0;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-line-num {
    display: inline-block;
    width: 3ch;
    margin-right: 12px;
    color: #555;
    text-align: right;
    user-select: none;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-stack-fn {
    color: #7ec8e3;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-stack-loc {
    color: #666;
  }

  .sibu-error-fallback .sibu-error-actions {
    display: flex;
    gap: 8px;
  }

  .sibu-error-fallback .sibu-error-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .sibu-error-fallback .sibu-error-btn-retry {
    background: #e5484d;
    color: white;
  }

  .sibu-error-fallback .sibu-error-btn-retry:hover {
    background: #d13438;
  }

  .sibu-error-fallback .sibu-error-btn-reload {
    background: #2a2a3e;
    color: #ccc;
    border: 1px solid #3a3a4e;
  }

  .sibu-error-fallback .sibu-error-btn-reload:hover {
    background: #3a3a4e;
  }
`;

// Inject styles only once
let stylesInjected = false;
function injectStyles() {
  if (!stylesInjected && typeof document !== "undefined") {
    const styleElement = style({ nodes: errorBoundaryStyles });
    document.head.appendChild(styleElement);
    stylesInjected = true;
  }
}

// Memoization cache for fallback elements keyed by error message
const fallbackCache = new WeakMap<(...args: never[]) => unknown, Map<string, Element>>();

function getMemoizedFallback(
  fallbackFn: (error: Error, retry: () => void) => Element,
  error: Error,
  retry: () => void,
): Element {
  let cache = fallbackCache.get(fallbackFn);
  if (!cache) {
    cache = new Map();
    fallbackCache.set(fallbackFn, cache);
  }
  const key = error.message;
  if (!cache.has(key)) {
    cache.set(key, fallbackFn(error, retry));
  }
  return cache.get(key) as Element;
}

interface StackFrame {
  fn: string;
  loc: string;
}

function parseStack(err: Error): { source: string; frames: StackFrame[] } {
  const stack = err.stack || "";
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];
  let source = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // Chrome/Edge: "at FunctionName (file:line:col)" or "at file:line:col"
    const chromeMatch = trimmed.match(/^at\s+(?:(.+?)\s+\((.+)\)|(.+))$/);
    if (chromeMatch) {
      const fn = chromeMatch[1] || "(anonymous)";
      const loc = chromeMatch[2] || chromeMatch[3] || "";
      frames.push({ fn, loc });
      if (!source && fn !== "(anonymous)" && !fn.startsWith("Object.") && !fn.startsWith("Module.")) {
        source = fn;
      }
      continue;
    }
    // Firefox/Safari: "functionName@file:line:col"
    const firefoxMatch = trimmed.match(/^(.+?)@(.+)$/);
    if (firefoxMatch) {
      const fn = firefoxMatch[1] || "(anonymous)";
      const loc = firefoxMatch[2] || "";
      frames.push({ fn, loc });
      if (!source && fn !== "(anonymous)") {
        source = fn;
      }
    }
  }

  return { source, frames };
}

/**
 * ErrorBoundary component using SibuJS reactive pattern.
 *
 * Features:
 * - Catches sync errors thrown by nodes
 * - Catches async errors (Promise rejections) from nodes
 * - Supports nested ErrorBoundaries (inner catches first, outer catches propagation)
 * - Retry functionality to clear error and re-render nodes
 * - Memoized fallback to avoid re-creating fallback UI on every render
 * - onError callback for logging/telemetry
 * - Improved CSS styling
 */
export function ErrorBoundary({ nodes, fallback, onError }: ErrorBoundaryProps): Element {
  injectStyles();

  const [error, setError] = signal<Error | null>(null);

  const retry = () => {
    // Clear memoized fallback cache on retry so fresh fallback is created
    if (fallback) {
      fallbackCache.delete(fallback);
    }
    setError(null);
  };

  const handleError = (e: unknown): Error => {
    const errorObj = e instanceof Error ? e : new Error(String(e));
    setError(errorObj);
    onError?.(errorObj);
    return errorObj;
  };

  const defaultFallback = (err: Error, retryFn: () => void) => {
    if (!_isDev) {
      return div({
        class: "sibu-error-fallback",
        nodes: [
          div({
            class: "sibu-error-header",
            nodes: [h3({ nodes: "Something went wrong", class: "sibu-error-title" }) as Element],
          }) as Element,
          div({
            class: "sibu-error-body",
            nodes: [
              p({ nodes: "An unexpected error occurred. Please try again.", class: "sibu-error-message" }) as Element,
              div({
                class: "sibu-error-actions",
                nodes: [
                  button({
                    nodes: "Retry",
                    class: "sibu-error-btn sibu-error-btn-retry",
                    on: { click: retryFn },
                  }) as Element,
                  button({
                    nodes: "Reload Page",
                    class: "sibu-error-btn sibu-error-btn-reload",
                    on: { click: () => location.reload() },
                  }) as Element,
                ],
              }) as Element,
            ],
          }) as Element,
        ],
      }) as Element;
    }

    const { source, frames } = parseStack(err);

    const fullText = `${err.message}\n\n${err.stack || ""}`;

    const copyBtn = button({
      nodes: "Copy",
      class: "sibu-error-copy-btn",
      on: {
        click: () => {
          navigator.clipboard.writeText(fullText).then(() => {
            (copyBtn as HTMLElement).textContent = "Copied!";
            setTimeout(() => {
              (copyBtn as HTMLElement).textContent = "Copy";
            }, 1500);
          });
        },
      },
    }) as Element;

    const stackLines: Element[] = frames.map(
      (f, i) =>
        div({
          nodes: [
            span({ class: "sibu-line-num", nodes: String(i + 1) }) as Element,
            span({ class: "sibu-stack-fn", nodes: f.fn }) as Element,
            span({ class: "sibu-stack-loc", nodes: ` ${f.loc}` }) as Element,
          ],
        }) as Element,
    );

    return div({
      class: "sibu-error-fallback",
      nodes: [
        div({
          class: "sibu-error-header",
          nodes: [
            h3({ nodes: source ? `Error in ${source}` : "Something went wrong", class: "sibu-error-title" }) as Element,
            ...(source ? [] : [span() as Element]),
          ],
        }) as Element,
        div({
          class: "sibu-error-body",
          nodes: [
            p({ nodes: err.message, class: "sibu-error-message" }) as Element,
            ...(frames.length > 0
              ? [
                  div({
                    class: "sibu-error-stack-container",
                    nodes: [
                      div({
                        class: "sibu-error-stack-label",
                        nodes: [span({ nodes: "Stack Trace" }) as Element, copyBtn],
                      }) as Element,
                      div({ class: "sibu-error-stack", nodes: [pre({ nodes: stackLines }) as Element] }) as Element,
                    ],
                  }) as Element,
                ]
              : []),
            div({
              class: "sibu-error-actions",
              nodes: [
                button({
                  nodes: "Retry",
                  class: "sibu-error-btn sibu-error-btn-retry",
                  on: { click: retryFn },
                }) as Element,
                button({
                  nodes: "Reload Page",
                  class: "sibu-error-btn sibu-error-btn-reload",
                  on: { click: () => location.reload() },
                }) as Element,
              ],
            }) as Element,
          ],
        }) as Element,
      ],
    }) as Element;
  };

  const tryRenderFallback = (err: Error): Element => {
    const fn = fallback || defaultFallback;
    try {
      return getMemoizedFallback(fn, err, retry);
    } catch (fallbackError) {
      // Fallback itself failed — propagate to parent ErrorBoundary via DOM event
      // Defer dispatch so the container is connected to the DOM tree first
      const propagateError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
      queueMicrotask(() => {
        if (container.parentNode) {
          container.dispatchEvent(
            new CustomEvent("sibu:error-propagate", {
              bubbles: true,
              detail: { error: propagateError },
            }),
          );
        }
      });
      return document.createComment("error-boundary-failed") as unknown as Element;
    }
  };

  const container = div({
    class: "sibu-error-boundary",
    nodes: () => {
      const currentError = error();

      if (currentError) {
        return tryRenderFallback(currentError);
      }

      try {
        const result = nodes();

        // Handle async nodes (Promise-returning components)
        if (result && typeof (result as unknown as Promise<Element>).then === "function") {
          const asyncContainer = div({ class: "sibu-error-async" }) as Element;
          asyncContainer.appendChild(span({ class: "sibu-lazy-loading", nodes: "Loading..." }));

          (result as unknown as Promise<Element>)
            .then((el: Element) => {
              asyncContainer.replaceChildren(el);
            })
            .catch((e: unknown) => {
              const err = handleError(e);
              asyncContainer.replaceChildren(tryRenderFallback(err));
            });

          return asyncContainer;
        }

        return result;
      } catch (e) {
        const errorObj = handleError(e);
        return tryRenderFallback(errorObj);
      }
    },
  }) as Element;

  // Listen for error propagation from nested ErrorBoundaries
  container.addEventListener("sibu:error-propagate", (e: Event) => {
    // If this boundary is already in error state, let the event bubble to parent
    if (error()) return;
    e.stopPropagation();
    const customEvent = e as CustomEvent;
    const propagatedError = customEvent.detail?.error;
    if (propagatedError) {
      handleError(propagatedError);
    }
  });

  return container;
}
