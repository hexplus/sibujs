import { signal } from "../core/signals/signal";

export interface SpeakOptions {
  /** BCP-47 language tag. Defaults to the utterance's default. */
  lang?: string;
  /** Playback speed (0.1–10). Default: 1. */
  rate?: number;
  /** Pitch (0–2). Default: 1. */
  pitch?: number;
  /** Volume (0–1). Default: 1. */
  volume?: number;
  /** Voice name (match against `getVoices()[i].name`). */
  voice?: string;
}

/**
 * speech wraps the Web Speech Synthesis API as a reactive controller.
 * Exposes `speaking` / `paused` reactive booleans plus `speak()`, `pause()`,
 * `resume()`, `cancel()` actions.
 *
 * Automatically gracefully degrades on runtimes without `speechSynthesis`.
 *
 * @example
 * ```ts
 * const tts = speech();
 * button(
 *   { on: { click: () => tts.speak("Hello, world!", { rate: 1.1 }) } },
 *   "Read it to me",
 * );
 * ```
 */
export function speech(): {
  speaking: () => boolean;
  paused: () => boolean;
  speak: (text: string, options?: SpeakOptions) => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  dispose: () => void;
} {
  const [speaking, setSpeaking] = signal(false);
  const [paused, setPaused] = signal(false);

  if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
    return {
      speaking,
      paused,
      speak: () => {},
      pause: () => {},
      resume: () => {},
      cancel: () => {},
      dispose: () => {},
    };
  }

  const synth = window.speechSynthesis;

  // Poll the synth state ONLY while something is actively speaking. Avoids
  // a 5-Hz wake-up forever on pages that may never call speak().
  let interval: ReturnType<typeof setInterval> | null = null;
  function startPolling(): void {
    if (interval !== null) return;
    interval = setInterval(() => {
      setSpeaking(synth.speaking);
      setPaused(synth.paused);
      if (!synth.speaking && !synth.paused) {
        clearInterval(interval as ReturnType<typeof setInterval>);
        interval = null;
      }
    }, 200);
  }

  let disposed = false;
  function speak(text: string, options: SpeakOptions = {}): void {
    if (disposed) return;
    const u = new SpeechSynthesisUtterance(text);
    if (options.lang) u.lang = options.lang;
    if (options.rate != null) u.rate = options.rate;
    if (options.pitch != null) u.pitch = options.pitch;
    if (options.volume != null) u.volume = options.volume;
    if (options.voice) {
      const voices = synth.getVoices();
      const match = voices.find((v) => v.name === options.voice);
      if (match) u.voice = match;
    }
    // { once: true } on end/error + a disposed-guard on start prevent signal
    // writes after dispose when synth.cancel() fires queued error events.
    u.addEventListener(
      "start",
      () => {
        if (!disposed) setSpeaking(true);
      },
      { once: true },
    );
    u.addEventListener(
      "end",
      () => {
        if (disposed) return;
        setSpeaking(false);
        setPaused(false);
      },
      { once: true },
    );
    u.addEventListener(
      "error",
      () => {
        if (disposed) return;
        setSpeaking(false);
        setPaused(false);
      },
      { once: true },
    );
    synth.speak(u);
    setSpeaking(true);
    startPolling();
  }

  function dispose(): void {
    disposed = true;
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    synth.cancel();
  }

  return {
    speaking,
    paused,
    speak,
    pause: () => synth.pause(),
    resume: () => synth.resume(),
    cancel: () => synth.cancel(),
    dispose,
  };
}
