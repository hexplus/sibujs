// ============================================================================
// ASYNC SERVER RENDERING
// ============================================================================
//
// `renderToString` serializes the tree as it is at the moment of the call.
// SibuJS builds part of a tree later than that — `when` / `match` / `each`
// commit their first branch in a microtask, `lazy()` chunks, `query()` /
// `resource()` fetches and the router's initial navigation resolve after an
// await — so a synchronous serialization of a fresh tree is mostly empty
// anchors. The async renderers below wait until the request has SETTLED:
//
//   - every microtask queued by the build has run (one macrotask turn), and
//   - every unit of work registered with `trackPending` (directly, or through
//     `prerenderWait`) has settled, and that stays true across another turn.
//
// Work is registered per request (`SSRStore.pending`), so concurrent renders
// never wait for each other.

import { DEV } from "../core/dev";
import { inScope } from "../core/rendering/adoptScope";
import { dispose } from "../core/rendering/dispose";
import { assertRequestIsolation, getRequestStore, type PendingWork, runInSSRContext } from "../core/ssr-context";
import { collectTransfer } from "../utils/transfer";
import { createServerAdoptScope } from "./hydrateAdopt";
import { ensureServerDom, explainServerError, watchBrowserApis } from "./serverDom";
import { collectServerHead } from "./serverHead";
import { assembleDocument, type DocumentOptions, renderToStringWith, serializeState } from "./ssr";

/** Default time a server render waits for pending work before serializing anyway. */
export const DEFAULT_SETTLE_TIMEOUT = 5000;

/** Default cap on the transferred state, in UTF-8 bytes (the `serializeState` default). */
export const DEFAULT_TRANSFER_MAX_BYTES = 1024 * 1024;

/** The window global the transferred state is assigned to. */
const TRANSFER_GLOBAL = "__SIBU_TRANSFER__";

/** Outcome of {@link settled}. */
export interface SettleResult {
  /** True when the timeout elapsed with work still pending. */
  timedOut: boolean;
  /** Labels of the work still pending at the timeout (`query:/api/catalog`). Empty when settled. */
  pending: string[];
}

/** Options of {@link settled}. */
export interface SettleOptions {
  /** Milliseconds to wait for pending work. Default 5000. */
  timeout?: number;
}

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

/**
 * Wait until the current request's render has settled: every deferred
 * directive commit has run and every registered async unit (lazy chunks,
 * `query()` / `resource()` fetches, router navigation and route loads,
 * `prerenderWait()` promises) has settled — or until `timeout`.
 *
 * Must be awaited inside the request's scope (`runInSSRContext`); outside one
 * there is no registry, and it only drains the microtask queue.
 *
 * @param _root The tree being rendered. Accepted for symmetry with test
 * helpers; settling is decided by the request's registry, not by the DOM.
 * @param options `timeout` in milliseconds (default 5000).
 * @returns Whether it timed out, and what was still pending.
 */
export async function settled(_root?: Node | null, options: SettleOptions = {}): Promise<SettleResult> {
  const store = getRequestStore();
  const timeout = options.timeout ?? DEFAULT_SETTLE_TIMEOUT;
  const deadline = Date.now() + timeout;
  for (;;) {
    // One macrotask turn runs every microtask the build queued, including the
    // ones those microtasks queue in turn.
    await macrotask();
    const pending = store?.pending;
    if (!pending || pending.size === 0) {
      // Confirm across another turn: a microtask chain that ended this turn
      // may have registered work (a branch that renders a `lazy()` child).
      await macrotask();
      if (!pending || pending.size === 0) return { timedOut: false, pending: [] };
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true, pending: describePending(pending) };
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (store && store.wake === done) store.wake = null;
        resolve();
      };
      const timer = setTimeout(done, remaining);
      if (store) store.wake = done;
    });
  }
}

function describePending(pending: Set<PendingWork>): string[] {
  const now = Date.now();
  return Array.from(pending, (work) => `${work.label} (${now - work.since} ms)`);
}

/** Diagnostics of one async server render. */
export interface RenderDiagnostics {
  /** True when the settle timeout elapsed; the output shows fallbacks for what was pending. */
  timedOut: boolean;
  /** Work still pending at the timeout. */
  pending: string[];
  /** Browser-only APIs read during the render (see `installServerDom`), with the reading site. */
  browserApis: string[];
  /** Size of the transferred state in UTF-8 bytes (0 when nothing was transferred). */
  stateBytes: number;
  /** The largest transferred entries, biggest first: `q:/api/catalog` → bytes. */
  largestState: Array<{ key: string; bytes: number }>;
  /** Entries left out of the transferred state because it exceeded `maxStateBytes`. */
  droppedState: string[];
  /** Wall-clock render time in milliseconds. */
  durationMs: number;
}

/** Result of {@link renderToStringAsync} and {@link renderToDocumentAsync}. */
export interface RenderResult {
  /** The rendered markup: the body content, or the whole document for `renderToDocumentAsync`. */
  html: string;
  /** Head tags collected during the render (`<title>`, meta, link, JSON-LD), escaped. */
  head: string;
  /** The transfer `<script>` restoring server data in the browser, or `""`. */
  state: string;
  /** The transferred data itself (what `state` assigns), or `null`. */
  stateData: Record<string, unknown> | null;
  /** HTTP status: 200 unless a router render decided otherwise (see `renderRoute`). */
  status: number;
  /** Diagnostics: pending work at the timeout, browser-API reads, state size. */
  diagnostics: RenderDiagnostics;
}

/** Options of {@link renderToStringAsync}. */
export interface AsyncRenderOptions {
  /** Milliseconds to wait for pending work before serializing anyway. Default 5000. */
  timeout?: number;
  /** Embed the data the render fetched so the browser does not fetch it again. Default `true`. */
  transfer?: boolean;
  /** CSP nonce for the transfer script. */
  nonce?: string;
  /** Cap on the transferred state in bytes. Larger entries are dropped (largest first). Default 1 MB. */
  maxStateBytes?: number;
  /**
   * Where the `data-sibu-ssr="true"` provenance marker goes. Default `"root"`:
   * top-level elements only (`renderToString` stamps every element, ~20 bytes
   * each, and nothing reads it beneath the root).
   */
  marker?: "all" | "root" | "none";
  /**
   * `"adopt"` marks the output for `hydrate(App, root, { strategy: "adopt" })`:
   * every element built by a tag factory or `html` carries its creation id
   * (`data-sibu-h`), so the browser binds to these nodes instead of replacing
   * them. Default: no markers (the output `hydrate()`'s replace strategy uses).
   */
  hydration?: "adopt" | "replace";
  /**
   * Log a one-block summary of the render in development (time, settle
   * outcome, what was pending, browser-API reads, transferred state and its
   * largest entries). A string labels it (`renderRoute` passes the URL).
   */
  log?: boolean | string;
}

/**
 * The diagnostics of one server render as readable text — what `log: true`
 * prints, for a custom logger or a test failure message.
 *
 * @param d The render's `diagnostics`.
 * @param label What was rendered (a URL).
 * @returns A multi-line summary.
 */
export function formatRenderDiagnostics(d: RenderDiagnostics, label = "render"): string {
  const lines = [
    `[SibuJS SSR] ${label}: ${d.durationMs} ms, ${d.timedOut ? "TIMED OUT (serialized with fallbacks)" : "settled"}`,
  ];
  if (d.pending.length > 0) lines.push(`  pending at the timeout: ${d.pending.join(", ")}`);
  if (d.browserApis.length > 0) lines.push(`  browser-only APIs read: ${d.browserApis.join("; ")}`);
  if (d.stateBytes > 0) {
    lines.push(
      `  transferred state: ${d.stateBytes} B; largest: ${d.largestState.map((e) => `${e.key} (${e.bytes} B)`).join(", ")}`,
    );
  }
  if (d.droppedState.length > 0) lines.push(`  left out of the state: ${d.droppedState.join(", ")}`);
  return lines.join("\n");
}

/**
 * Describe where a node sits, for an error message: `main > section.grid > div.card`.
 * The runtime has no component stack, so the DOM position is the component path.
 */
export function describeNodePath(node: unknown): string {
  const parts: string[] = [];
  let current = node as (Node & { parentNode: Node | null }) | null;
  while (current && parts.length < 8) {
    if (current.nodeType === 1) {
      const el = current as unknown as Element;
      let part = el.localName;
      const id = el.getAttribute("id");
      if (id) part += `#${id}`;
      const cls = el.getAttribute("class")?.trim().split(/\s+/)[0];
      if (cls) part += `.${cls}`;
      parts.unshift(part);
    }
    current = current.parentNode as typeof current;
  }
  return parts.length > 0 ? parts.join(" > ") : "(detached)";
}

/**
 * The error an async server render rejects with for an error no
 * `ErrorBoundary` claimed: the original as `cause`, the component name and DOM
 * path of the failing node in the message.
 * @internal
 */
export function renderFailure(entry: { error: unknown; context: { name?: string; node?: unknown } }): Error {
  const error = explainServerError(entry.error);
  const message = error instanceof Error ? error.message : String(error);
  const where = entry.context.node ? describeNodePath(entry.context.node) : "(unknown position)";
  const label = entry.context.name ? ` in ${entry.context.name}` : "";
  return new Error(`[SibuJS SSR] render failed${label} at ${where}: ${message}`, { cause: error });
}

function byteLength(text: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).byteLength : text.length;
}

/**
 * Serialize the transferred data, dropping the largest entries until it fits.
 * Data that cannot be serialized (a cycle, a BigInt) is dropped with it.
 */
function buildTransfer(
  data: Record<string, unknown>,
  maxBytes: number,
  nonce: string | undefined,
): {
  script: string;
  data: Record<string, unknown> | null;
  bytes: number;
  largest: Array<{ key: string; bytes: number }>;
  dropped: string[];
} {
  const entries: Array<{ section: string; key: string; value: unknown; bytes: number }> = [];
  const dropped: string[] = [];
  for (const section of Object.keys(data)) {
    if (section === "v") continue;
    const sectionEntries = data[section] as Record<string, unknown>;
    for (const key of Object.keys(sectionEntries)) {
      let json: string | undefined;
      try {
        json = JSON.stringify(sectionEntries[key]);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        dropped.push(`${section}:${key}`);
        continue;
      }
      entries.push({ section, key, value: sectionEntries[key], bytes: byteLength(json) + byteLength(key) + 4 });
    }
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  const largest = entries.slice(0, 5).map((e) => ({ key: `${e.section}:${e.key}`, bytes: e.bytes }));
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  let start = 0;
  while (total > maxBytes && start < entries.length) {
    dropped.push(`${entries[start].section}:${entries[start].key}`);
    total -= entries[start].bytes;
    start++;
  }
  const kept = entries.slice(start);
  if (dropped.length > 0 && DEV) {
    console.warn(
      `[SibuJS SSR] transferred state exceeded ${maxBytes} bytes or was not serializable; left out: ${dropped.join(", ")}. ` +
        `Largest entries: ${largest.map((e) => `${e.key} (${e.bytes} B)`).join(", ")}. ` +
        "Those queries fetch again in the browser. Raise `maxStateBytes` or mark them `ssr: false`.",
    );
  }
  if (kept.length === 0) return { script: "", data: null, bytes: 0, largest, dropped };
  const out: Record<string, unknown> = { v: data.v };
  for (const e of kept) {
    const section = (out[e.section] ??= Object.create(null)) as Record<string, unknown>;
    section[e.key] = e.value;
  }
  // Rebuilt as plain objects: `Object.create(null)` sections serialize the same.
  const script = serializeState(out, nonce, { maxBytes: Math.max(maxBytes * 2, 1024), global: TRANSFER_GLOBAL });
  return { script, data: out, bytes: total, largest, dropped };
}

interface RenderCore {
  content: string;
  result: Omit<RenderResult, "html">;
}

async function renderCore(input: Node | (() => Node), options: AsyncRenderOptions): Promise<RenderCore> {
  const started = Date.now();
  const store = getRequestStore();
  // Collect this request's unclaimed errors instead of logging them.
  const errors: NonNullable<NonNullable<typeof store>["errors"]> = [];
  if (store) store.errors = errors;

  // No DOM registered: build on the built-in server DOM. Under happy-dom or
  // jsdom, report browser-only APIs read during the render (development).
  ensureServerDom();
  watchBrowserApis();

  const ids = options.hydration === "adopt" ? new WeakMap<Element, string>() : null;
  const scope = ids ? createServerAdoptScope(ids) : null;

  let root: Node;
  try {
    root = typeof input === "function" ? inScope(scope, input) : input;
  } catch (err) {
    if (store) store.errors = undefined;
    throw explainServerError(err);
  }
  // A holder gives a root directive anchor the parent its deferred first render
  // requires, without adding an element to the output.
  const holder = document.createDocumentFragment();
  holder.appendChild(root);

  const settle = await settled(holder, { timeout: options.timeout });
  if (store) store.errors = undefined;

  const releaseTree = () => {
    for (const child of Array.from(holder.childNodes)) dispose(child);
  };

  if (errors.length > 0) {
    releaseTree();
    throw renderFailure(errors[0]);
  }

  if (settle.timedOut && DEV) {
    console.warn(
      `[SibuJS SSR] render did not settle within ${options.timeout ?? DEFAULT_SETTLE_TIMEOUT} ms; serialized with fallbacks for: ${settle.pending.join(", ")}`,
    );
  }

  const content = renderToStringWith(holder, { marker: options.marker ?? "root", ids });
  // The head resolves its getters against the settled tree, so it is
  // collected before the tree is released — and a getter that throws still
  // releases it.
  let head: string;
  try {
    head = collectServerHead();
  } catch (err) {
    releaseTree();
    throw err;
  }

  let state = "";
  let stateData: Record<string, unknown> | null = null;
  let stateBytes = 0;
  let largestState: Array<{ key: string; bytes: number }> = [];
  let droppedState: string[] = [];
  if (options.transfer !== false) {
    const collected = collectTransfer();
    if (collected) {
      const built = buildTransfer(collected, options.maxStateBytes ?? DEFAULT_TRANSFER_MAX_BYTES, options.nonce);
      state = built.script;
      stateData = built.data;
      stateBytes = built.bytes;
      largestState = built.largest;
      droppedState = built.dropped;
    }
  }

  releaseTree();

  const browserApis = Array.from((store?.slots?.get("browserApis") as Set<string> | undefined) ?? []);
  const diagnostics: RenderDiagnostics = {
    timedOut: settle.timedOut,
    pending: settle.pending,
    browserApis,
    stateBytes,
    largestState,
    droppedState,
    durationMs: Date.now() - started,
  };
  if (DEV && options.log) {
    console.info(formatRenderDiagnostics(diagnostics, typeof options.log === "string" ? options.log : undefined));
  }
  return { content, result: { head, state, stateData, status: 200, diagnostics } };
}

/** Run `fn` in the current request scope, or in a fresh one when there is none. */
function inRequest<T>(api: string, fn: () => Promise<T>): Promise<T> {
  try {
    assertRequestIsolation(api);
  } catch (err) {
    return Promise.reject(err);
  }
  return getRequestStore() ? fn() : runInSSRContext(fn);
}

/**
 * Render a tree to HTML once it has settled — one `await`, no manual
 * microtask waits.
 *
 * Pass a FUNCTION so the tree is built inside the request scope: its queries
 * then use the request's cache and its work is awaited. Called outside
 * `runInSSRContext`, it opens a scope of its own.
 *
 * Rejects when an error escapes the tree (no `ErrorBoundary` claimed it), with
 * the DOM path of the failing node in the message. A settle timeout does not
 * reject: what is ready is serialized, `Suspense` and `lazy()` keep their
 * fallbacks, and `diagnostics.pending` names what was still running.
 *
 * @param input The tree, or a function building it.
 * @param options Timeout, state transfer, nonce, state cap.
 * @returns `{ html, head, state, stateData, status, diagnostics }`.
 *
 * @example
 * ```ts
 * const { html, head, state } = await renderToStringAsync(() => App());
 * ```
 */
export function renderToStringAsync(
  input: Node | (() => Node),
  options: AsyncRenderOptions = {},
): Promise<RenderResult> {
  return inRequest("renderToStringAsync()", async () => {
    const { content, result } = await renderCore(input, options);
    return { html: content, ...result };
  });
}

/**
 * {@link renderToStringAsync}, wrapped in the document `renderToDocument`
 * produces. The collected head tags go into `<head>` and the transfer script
 * at the end of `<body>`, before `options.scripts`.
 *
 * @param input The tree, or a function building it.
 * @param options Document options plus the async render options.
 * @returns The render result; `html` is the whole document.
 */
export function renderToDocumentAsync(
  input: Node | (() => Node),
  options: DocumentOptions & AsyncRenderOptions = {},
): Promise<RenderResult> {
  return inRequest("renderToDocumentAsync()", async () => {
    const { content, result } = await renderCore(input, options);
    return { html: assembleDocument(content, options, result.head, result.state), ...result };
  });
}
