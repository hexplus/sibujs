import { signal } from "../core/signals/signal";

/**
 * Note on trust model: `BroadcastChannel` only delivers messages between
 * same-origin browsing contexts (tabs, iframes, workers). We therefore treat
 * incoming payloads as same-origin-trusted and pass them through unmodified.
 * Do not use this transport for cross-origin messaging.
 *
 * broadcast wraps the BroadcastChannel API as a reactive signal.
 * Unlike the `storage` event (which only fires for localStorage writes and
 * sends only the serialized value), a `BroadcastChannel` can send arbitrary
 * structured-cloneable payloads between same-origin tabs, iframes, and
 * workers — instantly, without touching storage.
 *
 * Returns the last received message as a reactive signal plus a `post()`
 * sender and `dispose()` cleanup. The `post()` call does NOT echo back into
 * the local `last()` signal — BroadcastChannel doesn't deliver to its own
 * sender, matching the browser's native behavior.
 *
 * @param channelName Name of the broadcast channel
 * @returns `{ last, post, dispose }`
 *
 * @example
 * ```ts
 * const chat = broadcast<{ user: string; text: string }>("chat");
 * chat.post({ user: "alice", text: "hi" });
 * effect(() => {
 *   const m = chat.last();
 *   if (m) renderIncoming(m);
 * });
 * ```
 */
export function broadcast<T = unknown>(
  channelName: string,
): { last: () => T | null; post: (message: T) => void; dispose: () => void } {
  if (typeof BroadcastChannel === "undefined") {
    const [last] = signal<T | null>(null);
    return { last, post: () => {}, dispose: () => {} };
  }

  const [last, setLast] = signal<T | null>(null);
  const channel = new BroadcastChannel(channelName);

  const handler = (ev: MessageEvent) => setLast(ev.data as T);
  channel.addEventListener("message", handler);

  function post(message: T): void {
    channel.postMessage(message);
  }

  function dispose(): void {
    channel.removeEventListener("message", handler);
    channel.close();
  }

  return { last, post, dispose };
}
