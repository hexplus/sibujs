import { div, span, style as styleTag } from "../core/rendering/html";

const loadingStyles = `
  @keyframes sibu-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes sibu-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .sibu-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    gap: 10px;
  }

  .sibu-loading-spinner {
    width: 24px;
    height: 24px;
    border: 3px solid #e0e0e0;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: sibu-spin 0.8s linear infinite;
  }

  .sibu-loading-dots {
    display: flex;
    gap: 4px;
  }

  .sibu-loading-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: #3b82f6;
    animation: sibu-pulse 1.2s ease-in-out infinite;
  }

  .sibu-loading-dot:nth-child(2) { animation-delay: 0.2s; }
  .sibu-loading-dot:nth-child(3) { animation-delay: 0.4s; }

  .sibu-loading-text {
    color: #6b7280;
    font-size: 14px;
  }

  .sibu-loading-sm .sibu-loading-spinner { width: 16px; height: 16px; border-width: 2px; }
  .sibu-loading-sm .sibu-loading-dot { width: 6px; height: 6px; }
  .sibu-loading-lg .sibu-loading-spinner { width: 40px; height: 40px; border-width: 4px; }
  .sibu-loading-lg .sibu-loading-dot { width: 12px; height: 12px; }
  .sibu-loading-lg .sibu-loading-dots { gap: 6px; }
`;

let loadingStylesInjected = false;
function injectLoadingStyles() {
  if (!loadingStylesInjected && typeof document !== "undefined") {
    document.head.appendChild(styleTag({ nodes: loadingStyles }));
    loadingStylesInjected = true;
  }
}

export interface LoadingProps {
  /** Text to show alongside the spinner */
  text?: string;
  /** Visual variant: "spinner" (default) or "dots" */
  variant?: "spinner" | "dots";
  /** Size: "sm", "md" (default), "lg" */
  size?: "sm" | "md" | "lg";
}

/**
 * Built-in loading indicator component.
 *
 * @example
 * ```ts
 * Loading();                             // Default spinner
 * Loading({ text: "Loading data..." });  // With text
 * Loading({ variant: "dots" });          // Dots animation
 * Loading({ size: "lg" });               // Large spinner
 * ```
 */
export function Loading(props: LoadingProps = {}): HTMLElement {
  injectLoadingStyles();

  const { text, variant = "spinner", size = "md" } = props;
  const sizeClass = size !== "md" ? ` sibu-loading-${size}` : "";

  if (variant === "dots") {
    return div({
      class: `sibu-loading${sizeClass}`,
      role: "status",
      "aria-live": "polite",
      // When there's no visible text, give the live region an accessible name
      // so it isn't announced as an empty status.
      "aria-label": text ? undefined : "Loading",
      nodes: [
        div({
          class: "sibu-loading-dots",
          nodes: [
            span({ class: "sibu-loading-dot" }) as HTMLElement,
            span({ class: "sibu-loading-dot" }) as HTMLElement,
            span({ class: "sibu-loading-dot" }) as HTMLElement,
          ],
        }) as HTMLElement,
        text ? (span({ class: "sibu-loading-text", nodes: text }) as HTMLElement) : null,
      ].filter(Boolean) as HTMLElement[],
    }) as HTMLElement;
  }

  return div({
    class: `sibu-loading${sizeClass}`,
    role: "status",
    "aria-live": "polite",
    "aria-label": text ? undefined : "Loading",
    nodes: [
      div({ class: "sibu-loading-spinner" }) as HTMLElement,
      text ? (span({ class: "sibu-loading-text", nodes: text }) as HTMLElement) : null,
    ].filter(Boolean) as HTMLElement[],
  }) as HTMLElement;
}
