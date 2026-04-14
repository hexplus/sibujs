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

    const safeUrl = validateSseUrl(url);
    if (safeUrl === null) {
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    source = new EventSource(safeUrl, {
      withCredentials: options?.withCredentials ?? false,
    });

    source.onopen = () => {
      setStatus("open");
      attempts = 0; // successful connection resets backoff
    };

    source.onmessage = (evt: MessageEvent) => {
      setData(evt.data);
      setEvent(evt.type);
    };

    source.onerror = () => {
      if (source && source.readyState === EventSource.CLOSED) {
        setStatus("closed");
        source = null;
        if (autoReconnect && !disposed && attempts < maxReconnects) {
          // Exponential backoff with jitter, capped at reconnectMaxMs.
          const delay = Math.min(maxMs, baseMs * 2 ** attempts);
          const jittered = delay * (0.5 + Math.random() * 0.5);
          attempts++;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, jittered);
        }
      }
    };
  }

  function close(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (source) {
      source.close();
      setStatus("closed");
      source = null;
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
