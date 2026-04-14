import { isDev } from "../core/dev";
import { button, code, div, h3, p, pre, span, style } from "../core/rendering/html";
import { signal } from "../core/signals/signal";

// ============================================================================
// ERROR DISPLAY COMPONENT
// ============================================================================
//
// A shared, rich UI for showing errors anywhere in a SibuJS app. It is
// used internally by `ErrorBoundary` and exported so applications can
// render the same look-and-feel from their own error paths (fetch
// failures, form submission errors, etc.).
//
// Features:
//   - Copy-to-clipboard button (full message + stack + metadata)
//   - Colored severity header ("error" red, "warning" amber)
//   - Parsed stack frames with line numbers, function name, file:line
//   - Error.cause chain walked and rendered as nested frames
//   - Error code badge (pulled from `error.code` or `error.name`)
//   - Timestamp + user-agent snapshot
//   - Retry + Reload action buttons (either optional)
//   - In production, stack and metadata are hidden by default; only the
//     headline message is shown to avoid leaking internal details.
//
// No dependencies, no JSX, no compilation — every element is built
// via the tag factories, and styles are injected once per page.

const _isDev = isDev();

export type ErrorSeverity = "error" | "warning" | "info";

export interface ErrorDisplayProps {
  /** The Error (or error-like value) to show. */
  error: unknown;
  /** Severity colour. Default `"error"`. */
  severity?: ErrorSeverity;
  /** Optional headline override. By default `error.message` is used. */
  title?: string;
  /**
   * Label for the primary action. Shown next to a Reload button.
   * Leave unset to hide the retry action.
   */
  retryLabel?: string;
  /** Callback for the retry button. */
  onRetry?: () => void;
  /**
   * If `true`, the Reload button is hidden. Useful for embedded
   * error panels where a full page reload is inappropriate.
   */
  hideReload?: boolean;
  /**
   * If `true`, the stack trace and metadata are always shown even in
   * production builds. Default: only shown in dev.
   */
  alwaysShowDetails?: boolean;
  /**
   * Extra metadata rendered as a key/value list under the message.
   * Useful for attaching request IDs, user IDs, etc.
   */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

// ─── Styles ──────────────────────────────────────────────────────────────

const STYLES = `
  .sibu-error-display {
    border: 1px solid var(--sibu-err-border, #e5484d);
    border-radius: 10px;
    margin: 12px 0;
    background: #0f0f1a;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e5e7eb;
    overflow: hidden;
  }
  .sibu-error-display[data-severity="warning"] { --sibu-err-border: #d97706; --sibu-err-accent: #d97706; }
  .sibu-error-display[data-severity="info"] { --sibu-err-border: #3b82f6; --sibu-err-accent: #3b82f6; }
  .sibu-error-display { --sibu-err-accent: #e5484d; }

  .sibu-error-display .sibu-err-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px;
    background: var(--sibu-err-accent);
    color: white;
    user-select: none;
  }
  .sibu-error-display .sibu-err-icon {
    font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
    font-weight: bold;
    font-size: 1.05em;
    padding: 2px 8px;
    background: rgba(0, 0, 0, 0.22);
    border-radius: 4px;
    letter-spacing: 0.02em;
  }
  .sibu-error-display .sibu-err-title {
    margin: 0;
    font-size: 0.98em;
    font-weight: 600;
    flex: 1;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  .sibu-error-display .sibu-err-timestamp {
    font-size: 0.75em;
    opacity: 0.85;
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
  }

  .sibu-error-display .sibu-err-body {
    padding: 16px 18px;
  }
  .sibu-error-display .sibu-err-message {
    font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
    margin: 0 0 14px;
    color: #fecaca;
    word-break: break-word;
    font-size: 0.9em;
    line-height: 1.55;
    padding: 10px 12px;
    background: rgba(229, 72, 77, 0.08);
    border-left: 3px solid var(--sibu-err-accent);
    border-radius: 4px;
  }

  .sibu-error-display .sibu-err-section {
    margin-top: 14px;
    border-radius: 6px;
    border: 1px solid #2a2a3e;
    background: #0a0a14;
    overflow: hidden;
  }
  .sibu-error-display .sibu-err-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #16162a;
    border-bottom: 1px solid #2a2a3e;
    font-size: 0.72em;
    color: #8b8fa3;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .sibu-error-display .sibu-err-copy-btn {
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.85);
    cursor: pointer;
    padding: 2px 10px;
    font-size: 0.78em;
    font-family: inherit;
    transition: all 0.12s ease;
    flex-shrink: 0;
  }
  .sibu-error-display .sibu-err-copy-btn:hover {
    background: rgba(0, 0, 0, 0.35);
    color: white;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .sibu-error-display .sibu-err-stack {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 0.8em;
    line-height: 1.7;
  }
  .sibu-error-display .sibu-err-frame {
    display: flex;
    gap: 10px;
    padding: 1px 0;
  }
  .sibu-error-display .sibu-err-line {
    display: inline-block;
    min-width: 2.2ch;
    color: #4b5066;
    text-align: right;
    user-select: none;
    flex-shrink: 0;
  }
  .sibu-error-display .sibu-err-fn {
    color: #7dd3fc;
    font-weight: 500;
  }
  .sibu-error-display .sibu-err-loc {
    color: #6b7280;
    white-space: nowrap;
  }
  .sibu-error-display .sibu-err-cause-label {
    margin: 12px 0 6px;
    color: #a0a3b8;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sibu-error-display .sibu-err-meta {
    margin: 0;
    padding: 10px 12px;
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
    font-size: 0.78em;
    color: #a0a3b8;
    display: grid;
    grid-template-columns: minmax(120px, auto) 1fr;
    gap: 4px 16px;
  }
  .sibu-error-display .sibu-err-meta dt { color: #6b7280; }
  .sibu-error-display .sibu-err-meta dd { margin: 0; color: #d1d5db; word-break: break-word; }

  .sibu-error-display .sibu-err-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .sibu-error-display .sibu-err-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.12s ease;
    font-family: inherit;
  }
  .sibu-error-display .sibu-err-btn-retry {
    background: var(--sibu-err-accent);
    color: white;
  }
  .sibu-error-display .sibu-err-btn-retry:hover { filter: brightness(1.1); }
  .sibu-error-display .sibu-err-btn-reload {
    background: #1f2133;
    color: #d1d5db;
    border: 1px solid #3a3a4e;
  }
  .sibu-error-display .sibu-err-btn-reload:hover { background: #2a2b40; }
`;

let _stylesInjected = false;
function injectStyles(): void {
  if (_stylesInjected || typeof document === "undefined") return;
  const el = style({ nodes: STYLES });
  document.head.appendChild(el);
  _stylesInjected = true;
}

// ─── Stack parsing ───────────────────────────────────────────────────────

interface StackFrame {
  fn: string;
  loc: string;
}

function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    // Chrome/V8: "at fn (file:line:col)" or "at file:line:col"
    const chrome = line.match(/^at\s+(?:(.+?)\s+\((.+)\)|(.+))$/);
    if (chrome) {
      frames.push({ fn: chrome[1] || "(anonymous)", loc: chrome[2] || chrome[3] || "" });
      continue;
    }
    // Firefox / Safari: "fn@file:line:col"
    const ff = line.match(/^(.+?)@(.+)$/);
    if (ff) {
      frames.push({ fn: ff[1] || "(anonymous)", loc: ff[2] || "" });
    }
  }
  return frames;
}

// ─── Error normalization ─────────────────────────────────────────────────

interface NormalizedError {
  code: string;
  message: string;
  stack: string;
  frames: StackFrame[];
  cause: NormalizedError | null;
}

function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code ?? err.name ?? "ERROR";
    const message = err.message || "Unknown error";
    const stack = err.stack ?? "";
    const frames = parseStack(stack);
    const rawCause = (err as Error & { cause?: unknown }).cause;
    const cause = rawCause != null ? normalizeError(rawCause) : null;
    return { code, message, stack, frames, cause };
  }
  return {
    code: "NON_ERROR",
    message: typeof err === "string" ? err : JSON.stringify(err),
    stack: "",
    frames: [],
    cause: null,
  };
}

function buildCopyText(err: NormalizedError, meta: Record<string, unknown> | undefined, headline: string): string {
  const lines: string[] = [];
  lines.push(headline);
  lines.push(`[${err.code}] ${err.message}`);
  if (err.stack) {
    lines.push("");
    lines.push("Stack Trace:");
    lines.push(err.stack);
  }
  let cause: NormalizedError | null = err.cause;
  while (cause) {
    lines.push("");
    lines.push("Caused by:");
    lines.push(`  [${cause.code}] ${cause.message}`);
    if (cause.stack) {
      const indented = cause.stack
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      lines.push(indented);
    }
    cause = cause.cause;
  }
  if (meta && Object.keys(meta).length > 0) {
    lines.push("");
    lines.push("Metadata:");
    for (const [k, v] of Object.entries(meta)) {
      lines.push(`  ${k}: ${String(v)}`);
    }
  }
  lines.push("");
  lines.push("Environment:");
  lines.push(`  Timestamp: ${new Date().toISOString()}`);
  if (typeof location !== "undefined") {
    lines.push(`  URL: ${location.href}`);
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    lines.push(`  User Agent: ${navigator.userAgent}`);
  }
  return lines.join("\n");
}

// ─── Render helpers ──────────────────────────────────────────────────────

function renderFrames(frames: StackFrame[]): Element {
  const rows = frames.map(
    (f, i) =>
      div({
        class: "sibu-err-frame",
        nodes: [
          span({ class: "sibu-err-line", nodes: String(i + 1) }) as Element,
          span({ class: "sibu-err-fn", nodes: f.fn }) as Element,
          span({ class: "sibu-err-loc", nodes: ` — ${f.loc}` }) as Element,
        ],
      }) as Element,
  );
  return pre({ class: "sibu-err-stack", nodes: rows }) as Element;
}

function renderCauseChain(cause: NormalizedError | null): Element[] {
  if (!cause) return [];
  return [
    div({ class: "sibu-err-cause-label", nodes: "Caused by" }) as Element,
    div({
      class: "sibu-err-section",
      nodes: [
        div({
          class: "sibu-err-section-head",
          nodes: [span({ nodes: `[${cause.code}] ${cause.message}` }) as Element, span({ nodes: "" }) as Element],
        }) as Element,
        cause.frames.length > 0
          ? (renderFrames(cause.frames) as unknown as Element)
          : (div({ class: "sibu-err-stack", nodes: "(no stack)" }) as Element),
      ],
    }) as Element,
    ...renderCauseChain(cause.cause),
  ];
}

function renderMetadata(meta: Record<string, string | number | boolean | null | undefined>): Element {
  const rows: Element[] = [];
  for (const [k, v] of Object.entries(meta)) {
    rows.push(document.createElement("dt") as unknown as Element);
    (rows[rows.length - 1] as unknown as HTMLElement).textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v == null ? "(null)" : String(v);
    rows.push(dd as unknown as Element);
  }
  const dl = document.createElement("dl");
  dl.className = "sibu-err-meta";
  for (const r of rows) dl.appendChild(r as unknown as Node);
  return dl as unknown as Element;
}

// ─── Main component ──────────────────────────────────────────────────────

/**
 * Rich error display component. Wire an error-like value in and get
 * a colored panel back with copy, retry, reload, stack, cause chain,
 * and metadata — all built from tag factories. Reusable anywhere
 * (inside `ErrorBoundary`, from a fetch failure, from a form submit).
 *
 * @example
 * ```ts
 * button(
 *   { on: { click: async () => {
 *     try { await save(); }
 *     catch (err) { mount(ErrorDisplay({ error: err, onRetry: save }), errorHost); }
 *   }}},
 *   "Save",
 * );
 * ```
 */
export function ErrorDisplay(props: ErrorDisplayProps): Element {
  injectStyles();

  const severity = props.severity ?? "error";
  const normalized = normalizeError(props.error);
  const showDetails = props.alwaysShowDetails ?? _isDev;
  const headline = props.title ?? normalized.message;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  const [copyLabel, setCopyLabel] = signal("Copy");

  const copyBtn = button({
    class: "sibu-err-copy-btn",
    nodes: () => copyLabel(),
    on: {
      click: () => {
        const text = buildCopyText(normalized, props.metadata, headline);
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(text).then(
            () => {
              setCopyLabel("Copied!");
              setTimeout(() => setCopyLabel("Copy"), 1500);
            },
            () => {
              setCopyLabel("Copy failed");
              setTimeout(() => setCopyLabel("Copy"), 1500);
            },
          );
        }
      },
    },
  }) as Element;

  const header = div({
    class: "sibu-err-header",
    nodes: [
      code({ class: "sibu-err-icon", nodes: normalized.code }) as Element,
      h3({ class: "sibu-err-title", nodes: headline }) as Element,
      copyBtn,
      span({ class: "sibu-err-timestamp", nodes: timestamp }) as Element,
    ],
  }) as Element;

  const bodyChildren: Element[] = [p({ class: "sibu-err-message", nodes: normalized.message }) as Element];

  if (showDetails && normalized.frames.length > 0) {
    bodyChildren.push(
      div({
        class: "sibu-err-section",
        nodes: [
          div({
            class: "sibu-err-section-head",
            nodes: [span({ nodes: "Stack Trace" }) as Element],
          }) as Element,
          renderFrames(normalized.frames),
        ],
      }) as Element,
    );
  }

  if (showDetails) {
    bodyChildren.push(...renderCauseChain(normalized.cause));
  }

  if (showDetails && props.metadata && Object.keys(props.metadata).length > 0) {
    bodyChildren.push(
      div({
        class: "sibu-err-section",
        nodes: [
          div({ class: "sibu-err-section-head", nodes: [span({ nodes: "Metadata" }) as Element] }) as Element,
          renderMetadata(props.metadata),
        ],
      }) as Element,
    );
  }

  // Actions
  const actionButtons: Element[] = [];
  if (props.onRetry) {
    actionButtons.push(
      button({
        class: "sibu-err-btn sibu-err-btn-retry",
        nodes: props.retryLabel ?? "Retry",
        on: { click: props.onRetry },
      }) as Element,
    );
  }
  if (!props.hideReload && typeof location !== "undefined") {
    actionButtons.push(
      button({
        class: "sibu-err-btn sibu-err-btn-reload",
        nodes: "Reload Page",
        on: { click: () => location.reload() },
      }) as Element,
    );
  }
  if (actionButtons.length > 0) {
    bodyChildren.push(div({ class: "sibu-err-actions", nodes: actionButtons }) as Element);
  }

  const body = div({ class: "sibu-err-body", nodes: bodyChildren }) as Element;

  return div({
    class: "sibu-error-display",
    "data-severity": severity,
    nodes: [header, body],
  }) as Element;
}
