import { signal } from "../core/signals/signal";

/**
 * Validate a WebSocket URL. Only `ws:` and `wss:` schemes are allowed —
 * a `javascript:` or `data:` URI would not actually open a socket, but
 * an attacker-controlled URL that reaches a non-WebSocket endpoint is
 * still unwanted. The check is deliberately minimal: strip whitespace,
 * lowercase, require the scheme. No host allowlist here — that is the
 * caller's job (sibujs cannot know which hosts are trusted).
 *
 * Returns the trimmed URL if safe, or `null` if unsafe.
 */
function validateWsUrl(raw: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping chars browsers silently ignore during protocol parsing
  const trimmed = raw.replace(/[\x00-\x20\x7f-\x9f]+/g, "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("ws://") || lower.startsWith("wss://")) return trimmed;
  return null;
}

/**
 * socket provides a reactive WebSocket connection with auto-reconnect
 * and optional heartbeat support.
 *
 * Security: the URL is validated against `ws://` / `wss://` only —
 * `javascript:` and similar schemes are refused (status stays `"closed"`).
 */
export function socket(
  url: string | (() => string),
  options?: {
    protocols?: string | string[];
    autoReconnect?: boolean;
    reconnectDelay?: number;
    maxReconnects?: number;
    heartbeat?: { interval: number; message: string };
  },
): {
  data: () => unknown;
  status: () => "connecting" | "open" | "closing" | "closed";
  send: (data: string | ArrayBufferLike | Blob) => void;
  close: () => void;
  dispose: () => void;
} {
  const autoReconnect = options?.autoReconnect ?? false;
  const reconnectDelay = options?.reconnectDelay ?? 1000;
  // Bound default to 10 attempts so a permanently broken URL doesn't hammer
  // the server forever. Callers can pass Infinity if that behavior is wanted.
  const maxReconnects = options?.maxReconnects ?? 10;
  const heartbeat = options?.heartbeat;
  const protocols = options?.protocols;

  const [data, setData] = signal<unknown>(null);
  const [status, setStatus] = signal<"connecting" | "open" | "closing" | "closed">("closed");

  let ws: WebSocket | null = null;
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let manuallyClosed = false;

  function getUrl(): string {
    return typeof url === "function" ? url() : url;
  }

  function connect(): void {
    if (disposed) return;

    const safeUrl = validateWsUrl(getUrl());
    if (safeUrl === null) {
      // Unsafe URL — stay closed and do not attempt a connection.
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    ws = new WebSocket(safeUrl, protocols);

    ws.onopen = () => {
      setStatus("open");
      reconnectCount = 0;
      startHeartbeat();
    };

    ws.onmessage = (event: MessageEvent) => {
      setData(event.data);
    };

    ws.onclose = () => {
      setStatus("closed");
      stopHeartbeat();
      const wasManual = manuallyClosed;
      // Reset BEFORE scheduling so close() during the timer window correctly
      // re-sets manuallyClosed and the scheduled reconnect short-circuits.
      manuallyClosed = false;
      if (autoReconnect && !disposed && !wasManual && reconnectCount < maxReconnects) {
        // Exponential backoff with jitter, capped at 30s.
        const cap = 30_000;
        const delay = Math.min(cap, reconnectDelay * 2 ** reconnectCount);
        const jittered = delay * (0.5 + Math.random() * 0.5);
        reconnectCount++;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (disposed || manuallyClosed) return;
          connect();
        }, jittered);
      }
    };

    ws.onerror = () => {
      // Error will be followed by close event
    };
  }

  function startHeartbeat(): void {
    if (!heartbeat) return;
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(heartbeat.message);
      }
    }, heartbeat.interval);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function send(msg: string | ArrayBufferLike | Blob): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }

  function close(): void {
    manuallyClosed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    if (ws) {
      setStatus("closing");
      ws.close();
    }
  }

  function dispose(): void {
    disposed = true;
    close();
  }

  // Auto-connect on creation
  connect();

  return { data, status, send, close, dispose };
}
