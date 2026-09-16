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
  // Invocation counter. Writes can settle out of order (a permission prompt on
  // one, not the other), and only the most recent copy() may publish state or
  // own the `copied` timer — otherwise an older write resolving late overwrote
  // the newer value and replaced its reset timer. dispose() bumps it too.
  let generation = 0;

  async function copy(value: string): Promise<void> {
    if (disposed) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    const mine = ++generation;
    await navigator.clipboard.writeText(value);

    // Re-check AFTER the await, not just before it: the controller may have
    // been disposed, or a newer copy() started, while this write was pending.
    // A superseded write resolves normally for its caller but publishes nothing.
    if (disposed || mine !== generation) return;

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
    generation++;
    if (copiedTimer !== null) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
  }

  return { text, copy, copied, dispose };
}
