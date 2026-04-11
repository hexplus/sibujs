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
 * button({
 *   nodes: "Read it to me",
 *   on: { click: () => tts.speak("Hello, world!", { rate: 1.1 }) },
 * });
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

  // Poll the synth state — the spec doesn't dispatch events for every
  // transition on every browser, so periodic sync is the safest approach.
  const interval = setInterval(() => {
    setSpeaking(synth.speaking);
    setPaused(synth.paused);
  }, 200);

  function speak(text: string, options: SpeakOptions = {}): void {
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
    u.addEventListener("start", () => setSpeaking(true));
    u.addEventListener("end", () => {
      setSpeaking(false);
      setPaused(false);
    });
    u.addEventListener("error", () => {
      setSpeaking(false);
      setPaused(false);
    });
    synth.speak(u);
  }

  function dispose(): void {
    clearInterval(interval);
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
