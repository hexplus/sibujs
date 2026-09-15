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
  // Bumped by close()/dispose(): code that publishes a status re-checks it, so a
  // subscriber closing or disposing during that publication is noticed before
  // any socket or timer is acquired.
  let lifecycle = 0;

  function getUrl(): string {
    return typeof url === "function" ? url() : url;
  }

  function connect(): void {
    if (disposed) return;
    // WebSocket is absent under SSR and some edge runtimes — degrade to a
    // closed socket instead of throwing at construction.
    if (typeof WebSocket === "undefined") {
      setStatus("closed");
      return;
    }

    const safeUrl = validateWsUrl(getUrl());
    if (safeUrl === null) {
      // Unsafe URL — stay closed and do not attempt a connection.
      setStatus("closed");
      return;
    }

    const generation = lifecycle;
    setStatus("connecting");
    if (disposed || generation !== lifecycle) return;
    const instance = new WebSocket(safeUrl, protocols);
    if (disposed || generation !== lifecycle) {
      instance.close();
      return;
    }
    ws = instance;

    // Every handler is identity-checked: events still arriving from a socket
    // that has since been replaced (after a reconnect) must not touch state.
    instance.onopen = () => {
      if (ws !== instance) return;
      const openGeneration = lifecycle;
      setStatus("open");
      // A subscriber that closed or disposed on "open" must not get a heartbeat.
      if (disposed || openGeneration !== lifecycle || ws !== instance) return;
      reconnectCount = 0;
      startHeartbeat();
    };

    instance.onmessage = (event: MessageEvent) => {
      if (ws !== instance) return;
      setData(event.data);
    };

    instance.onclose = () => {
      if (ws !== instance) return;
      // Release the closed instance, so a later close() knows there is nothing
      // left to close instead of reporting "closing" forever.
      ws = null;
      const closeGeneration = lifecycle;
      setStatus("closed");
      stopHeartbeat();
      const wasManual = manuallyClosed || closeGeneration !== lifecycle;
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

    instance.onerror = () => {
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
    lifecycle++;
    manuallyClosed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    if (!ws) {
      // Nothing open: already closed (remotely or before), so it stays closed.
      setStatus("closed");
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      // Closed without our handler having run: no close event will follow.
      ws = null;
      setStatus("closed");
      return;
    }
    if (ws.readyState !== WebSocket.CLOSING) {
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
