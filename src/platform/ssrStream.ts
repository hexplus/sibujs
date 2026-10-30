// ============================================================================
// STREAMING WITH OUT-OF-ORDER SUSPENSE
// ============================================================================
//
//   renderToReadableStream(() => App(), { document: { scripts: ["/main.js"] } })
//
//   1. <head> + the shell      once everything OUTSIDE the `Suspense`
//                              boundaries has settled; each boundary still
//                              shows its fallback
//   2. one chunk per boundary   as soon as THAT boundary's content (and the
//                              work started inside it) is ready, in whatever
//                              order they finish: the content in a hidden
//                              element plus a small swap script (CSP nonce)
//   3. the transfer state, the scripts, </body></html>
//
// Pending work is attributed to the boundary it was started in (see
// `core/rendering/streamBoundary.ts`), so a slow boundary holds only itself.
// Chunks are produced on demand: the renderer waits while the consumer has not
// taken the previous chunk (backpressure).

import { DEV } from "../core/dev";
import { inScope } from "../core/rendering/adoptScope";
import { dispose } from "../core/rendering/dispose";
import { runInBoundary, type StreamBoundary, setBoundaryHook } from "../core/rendering/streamBoundary";
import { getRequestStore, type PendingWork, requestSlot, runInSSRContext } from "../core/ssr-context";
import { collectTransfer } from "../utils/transfer";
import { createServerAdoptScope } from "./hydrateAdopt";
import { ensureServerDom, explainServerError, watchBrowserApis } from "./serverDom";
import { collectServerHead } from "./serverHead";
import { assembleDocument, type DocumentOptions, renderToStringWith, serializeState, suspenseSwapScript } from "./ssr";
import { type AsyncRenderOptions, DEFAULT_TRANSFER_MAX_BYTES, describeNodePath } from "./ssrAsync";

/** Options of the streaming `renderToReadableStream(() => App(), options)`. */
export interface StreamRenderOptions extends AsyncRenderOptions {
  /**
   * Wrap the stream in `renderToDocument`'s document (head tags flushed with
   * the shell, the transfer script and `scripts` at the end). Default `{}`;
   * `false` streams the body markup only.
   */
  document?: DocumentOptions | false;
  /** Total time for every boundary (default 10 000 ms); a boundary still pending keeps its fallback. */
  timeout?: number;
  /** Time for the shell itself (default 5000 ms); past it the shell flushes with what is ready. */
  shellTimeout?: number;
}

interface BoundaryRecord {
  id: string;
  container: Element;
  done: boolean;
  emitted: boolean;
  /** The fallback's markup, captured before the content first builds. */
  fallbackHtml: string | null;
  api: StreamBoundary;
}

interface StreamState {
  boundaries: BoundaryRecord[];
  serialize: ((node: Node) => string) | null;
}

let hookInstalled = false;

function installHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  // One process-wide hook; it answers only inside a streaming render's request.
  setBoundaryHook((container) => {
    const state = requestSlot<StreamState>("stream");
    const store = getRequestStore();
    if (!state || !store) return null;
    const id = `sibu-sus-${store.suspenseIdCounter++}`;
    container.setAttribute("data-sibu-suspense-id", id);
    const record: BoundaryRecord = {
      id,
      container,
      done: false,
      emitted: false,
      fallbackHtml: null,
      api: {
        enter: (fn) => {
          // The container still holds the fallback when the content first builds.
          if (record.fallbackHtml === null && state.serialize) {
            record.fallbackHtml = Array.from(container.childNodes, (n) => state.serialize?.(n) ?? "").join("");
          }
          return runInBoundary(record.api, fn);
        },
        done: () => {
          record.done = true;
          store.wake?.();
        },
      },
    };
    state.boundaries.push(record);
    return record.api;
  });
}

/** A one-slot channel: `push` resolves once the consumer has taken the chunk. */
function createChannel() {
  const chunks: string[] = [];
  let taken: (() => void) | null = null;
  let arrived: (() => void) | null = null;
  let ended = false;
  let cancelled = false;
  let error: unknown;
  return {
    get cancelled() {
      return cancelled;
    },
    async push(chunk: string): Promise<void> {
      if (cancelled || chunk === "") return;
      chunks.push(chunk);
      arrived?.();
      arrived = null;
      await new Promise<void>((resolve) => {
        taken = resolve;
      });
    },
    end(): void {
      ended = true;
      arrived?.();
    },
    fail(err: unknown): void {
      error = err;
      ended = true;
      arrived?.();
    },
    cancel(): void {
      cancelled = true;
      taken?.();
    },
    async take(): Promise<{ value?: string; done: boolean }> {
      for (;;) {
        if (chunks.length > 0) {
          const value = chunks.shift() as string;
          const release = taken;
          taken = null;
          release?.();
          return { value, done: false };
        }
        if (error !== undefined) throw error;
        if (ended) return { done: true };
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
    },
  };
}

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

/** Wait until `ready()` holds across a macrotask turn, or the deadline passes. */
async function waitFor(ready: () => boolean, deadline: number): Promise<boolean> {
  const store = getRequestStore();
  for (;;) {
    await macrotask();
    if (ready()) {
      await macrotask();
      if (ready()) return true;
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (store && store.wake === done) store.wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.min(remaining, 50));
      if (store) store.wake = done;
    });
  }
}

function pendingFor(pending: Set<PendingWork> | undefined, boundary: StreamBoundary | undefined): boolean {
  if (!pending) return false;
  for (const work of pending) if (work.boundary === boundary) return true;
  return false;
}

/**
 * Stream a page with out-of-order `Suspense` boundaries. Reached through
 * `renderToReadableStream(() => App(), options)`.
 * @internal
 */
export function streamPage(input: () => Node, options: StreamRenderOptions = {}): ReadableStream<string> {
  installHook();
  const channel = createChannel();
  const nonce = options.nonce;
  const doc = options.document === false ? null : (options.document ?? {});
  const MARK_BODY = "\u0000sibu-body\u0000";
  const MARK_END = "\u0000sibu-end\u0000";

  void runInSSRContext(async () => {
    const store = getRequestStore();
    const state: StreamState = { boundaries: [], serialize: null };
    requestSlot("stream", () => state);
    const errors: NonNullable<NonNullable<typeof store>["errors"]> = [];
    if (store) store.errors = errors;
    let holder: DocumentFragment | null = null;
    try {
      ensureServerDom();
      watchBrowserApis();
      const ids = options.hydration === "adopt" ? new WeakMap<Element, string>() : null;
      const scope = ids ? createServerAdoptScope(ids) : null;
      let root: Node;
      try {
        root = inScope(scope, input);
      } catch (err) {
        throw explainServerError(err);
      }
      const serialize = (node: Node) => renderToStringWith(node, { marker: options.marker ?? "root", ids });
      state.serialize = serialize;
      holder = document.createDocumentFragment();
      holder.appendChild(root);
      const ready = (b: BoundaryRecord) => b.done && !pendingFor(store?.pending, b.api);
      // Serialize `node` with every not-ready boundary inside it showing its
      // fallback: its in-progress content is held aside for the duration.
      const serializeWithFallbacks = (node: Node): string => {
        const held: Array<{ b: BoundaryRecord; nodes: ChildNode[]; mark: Comment }> = [];
        for (const b of state.boundaries) {
          if (ready(b) || b.container === node || !node.contains(b.container)) continue;
          if (held.some((h) => h.b.container.contains(b.container))) continue;
          const nodes = Array.from(b.container.childNodes);
          for (const n of nodes) b.container.removeChild(n);
          const mark = document.createComment(`sibu-fallback:${b.id}`);
          b.container.appendChild(mark);
          held.push({ b, nodes, mark });
        }
        let html = serialize(node);
        for (const { b, nodes, mark } of held) {
          b.container.removeChild(mark);
          for (const n of nodes) b.container.appendChild(n);
          html = html.replace(`<!--sibu-fallback:${b.id}-->`, b.fallbackHtml ?? "");
        }
        return html;
      };

      // 1 — the shell: everything outside the boundaries.
      const shellDeadline = Date.now() + (options.shellTimeout ?? 5000);
      await waitFor(() => !pendingFor(store?.pending, undefined), shellDeadline);
      if (errors.length > 0) {
        const { error, context } = errors[0];
        throw new Error(
          `[SibuJS SSR] render failed at ${context.node ? describeNodePath(context.node) : "(unknown position)"}: ${explainServerError(error) instanceof Error ? (explainServerError(error) as Error).message : String(error)}`,
          { cause: error },
        );
      }
      // Boundaries already done are part of the shell.
      for (const b of state.boundaries) if (b.done && !pendingFor(store?.pending, b.api)) b.emitted = true;
      const shell = serializeWithFallbacks(holder);
      const head = collectServerHead();
      let after = "";
      let between = "";
      if (doc) {
        const page = assembleDocument(MARK_BODY, doc, head, MARK_END);
        const [start, rest] = page.split(MARK_BODY);
        [between, after] = rest.split(MARK_END);
        await channel.push(start + shell);
      } else {
        await channel.push(shell);
      }
      if (channel.cancelled) return;

      // 2 — boundaries, in the order they finish.
      const deadline = Date.now() + (options.timeout ?? 10_000);
      const outstanding = () => state.boundaries.filter((b) => !b.emitted);
      let bodyClosed = false;
      for (;;) {
        if (outstanding().length === 0) break;
        const next = outstanding().find(ready);
        if (!next) {
          const progressed = await waitFor(() => outstanding().some(ready) || outstanding().length === 0, deadline);
          if (!progressed) break;
          continue;
        }
        if (!bodyClosed && doc) {
          await channel.push(between);
          bodyClosed = true;
        }
        // Done boundaries nested inside this one travel with it.
        for (const b of state.boundaries)
          if (b !== next && ready(b) && next.container.contains(b.container)) b.emitted = true;
        next.emitted = true;
        if (!next.container.isConnected && !holder.contains(next.container)) continue;
        let html = "";
        for (const child of Array.from(next.container.childNodes)) html += serializeWithFallbacks(child);
        await channel.push(
          `<div hidden id="sibu-resolved-${next.id}">${html}</div>${suspenseSwapScript(next.id, nonce)}`,
        );
        if (channel.cancelled) return;
      }
      if (DEV && outstanding().length > 0) {
        console.warn(
          `[SibuJS SSR] streaming: ${outstanding().length} Suspense boundar${outstanding().length === 1 ? "y" : "ies"} did not resolve within ${options.timeout ?? 10_000} ms and kept the fallback.`,
        );
      }

      // 3 — state and the end of the document.
      let stateScript = "";
      if (options.transfer !== false) {
        const data = collectTransfer();
        if (data) {
          try {
            stateScript = serializeState(data, nonce, {
              maxBytes: options.maxStateBytes ?? DEFAULT_TRANSFER_MAX_BYTES,
              global: "__SIBU_TRANSFER__",
            });
          } catch (err) {
            if (DEV) console.warn("[SibuJS SSR] streaming: transferred state left out:", err);
          }
        }
      }
      if (doc) {
        await channel.push((bodyClosed ? "" : between) + stateScript + after);
      } else if (stateScript) {
        await channel.push(stateScript);
      }
      channel.end();
    } catch (err) {
      channel.fail(err);
    } finally {
      if (store) store.errors = undefined;
      if (holder) for (const child of Array.from(holder.childNodes)) dispose(child);
    }
  });

  return new ReadableStream<string>({
    async pull(controller) {
      const { value, done } = await channel.take();
      if (done) controller.close();
      else controller.enqueue(value as string);
    },
    cancel() {
      channel.cancel();
    },
  });
}
