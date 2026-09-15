import { signal } from "../core/signals/signal";
import { sanitizeUrl } from "../utils/sanitize";

/**
 * Validate an EventSource URL. Only `http://`, `https://`, and relative
 * paths are allowed — `javascript:`, `data:`, `blob:`, etc. are refused.
 * Returns `null` on failure.
 */
function validateSseUrl(raw: string): string | null {
  const safe = sanitizeUrl(raw);
  if (!safe) return null;
  return safe;
}

/**
 * stream provides reactive Server-Sent Events (SSE) integration.
 * Wraps the EventSource API with reactive state for data, event name, and connection status.
 *
 * Security: the URL is passed through `sanitizeUrl()` — `javascript:`,
 * `data:`, `vbscript:`, and `blob:` URIs are refused and the stream
 * stays in `"closed"` state.
 */
export function stream(
  url: string,
  options?: {
    withCredentials?: boolean;
    autoReconnect?: boolean;
    maxReconnects?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  },
): {
  data: () => string | null;
  event: () => string | null;
  status: () => "connecting" | "open" | "closed";
  close: () => void;
  dispose: () => void;
} {
  const autoReconnect = options?.autoReconnect ?? false;
  const maxReconnects = options?.maxReconnects ?? 10;
  const baseMs = options?.reconnectBaseMs ?? 1000;
  const maxMs = options?.reconnectMaxMs ?? 30_000;

  const [data, setData] = signal<string | null>(null);
  const [event, setEvent] = signal<string | null>(null);
  const [status, setStatus] = signal<"connecting" | "open" | "closed">("connecting");

  let source: EventSource | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  function connect(): void {
    if (disposed) return;
    // EventSource is absent under SSR and some edge runtimes — degrade to a
    // closed stream instead of throwing at construction.
    if (typeof EventSource === "undefined") {
      setStatus("closed");
      return;
    }

    const safeUrl = validateSseUrl(url);
    if (safeUrl === null) {
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    const instance = new EventSource(safeUrl, {
      withCredentials: options?.withCredentials ?? false,
    });
    source = instance;
    // Every handler checks it still belongs to the live source: callbacks from a
    // closed, disposed or replaced EventSource used to reopen the status, publish
    // late data, or (onerror) act on the NEW source's state.
    const live = () => !disposed && source === instance;

    instance.onopen = () => {
      if (!live()) return;
      setStatus("open");
      attempts = 0; // successful connection resets backoff
    };

    instance.onmessage = (evt: MessageEvent) => {
      if (!live()) return;
      setData(evt.data);
      setEvent(evt.type);
    };

    instance.onerror = () => {
      if (!live() || instance.readyState !== EventSource.CLOSED) return;
      detach(instance);
      source = null;
      setStatus("closed");
      if (autoReconnect && attempts < maxReconnects) {
        // Exponential backoff with jitter, capped at reconnectMaxMs.
        const delay = Math.min(maxMs, baseMs * 2 ** attempts);
        const jittered = delay * (0.5 + Math.random() * 0.5);
        attempts++;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, jittered);
      }
    };
  }

  function detach(instance: EventSource): void {
    instance.onopen = null;
    instance.onmessage = null;
    instance.onerror = null;
  }

  function close(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const instance = source;
    if (instance) {
      // Invalidate and detach before the native close, so nothing it (or a
      // queued event) delivers can reach this stream's state.
      source = null;
      detach(instance);
      instance.close();
      setStatus("closed");
    }
  }

  function dispose(): void {
    disposed = true;
    close();
  }

  // Auto-connect on creation
  connect();

  return { data, event, status, close, dispose };
}
