import { signal } from "../core/signals/signal";

/**
 * clipboard provides reactive access to the async Clipboard API.
 * Tracks the last copied text and provides a `copied` indicator
 * that resets after 2 seconds.
 *
 * OWNERSHIP: `navigator.clipboard.writeText()` is an unbounded async gap — it
 * can sit on a permission prompt indefinitely. A write that resolves after
 * `dispose()` must not touch state or arm a timer: the component that owned
 * this controller is gone, so a `copied` flash it schedules fires against a
 * torn-down subtree and keeps the controller (and its closure) alive for two
 * more seconds for nothing.
 */
export function clipboard(): {
  text: () => string;
  copy: (text: string) => Promise<void>;
  copied: () => boolean;
  dispose: () => void;
} {
  const [text, setText] = signal("");
  const [copied, setCopied] = signal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function copy(value: string): Promise<void> {
    if (disposed) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(value);

    // Re-check AFTER the await, not just before it. This is the whole point:
    // the controller may have been disposed while the write was pending.
    if (disposed) return;

    setText(value);
    setCopied(true);

    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (disposed) return;
      setCopied(false);
      copiedTimer = null;
    }, 2000);
  }

  function dispose() {
    disposed = true;
    if (copiedTimer !== null) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
  }

  return { text, copy, copied, dispose };
}
