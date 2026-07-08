import { signal } from "@sibujs/core";

/**
 * clipboard provides reactive access to the async Clipboard API.
 * Tracks the last copied text and provides a `copied` indicator
 * that resets after 2 seconds.
 *
 * @returns Object with reactive text getter, copy function, copied indicator, and dispose
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

  async function copy(value: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setText(value);
    setCopied(true);

    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      setCopied(false);
      copiedTimer = null;
    }, 2000);
  }

  function dispose() {
    if (copiedTimer !== null) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
  }

  return { text, copy, copied, dispose };
}
