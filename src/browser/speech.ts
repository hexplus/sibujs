import { signal } from "../core/signals/signal";
import { globalSingleton } from "../utils/globalSingleton";

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

// ─── Shared, owner-aware utterance queue ────────────────────────────────────
//
// `speechSynthesis` has ONE global queue and its pause/resume/cancel act on all
// of it. Controllers used to call those globals directly, so disposing one
// component cancelled speech queued by every other controller and by
// application code. Instead, SibuJS utterances wait in this shared queue, tagged
// with their owner, and are handed to the native queue one at a time. A
// controller then only ever affects its own utterances; the native queue is
// touched only when the utterance being spoken belongs to that controller.

interface SpeechOwner {
  paused: boolean;
  /** Recompute this controller's reactive state from the coordinator. */
  sync: () => void;
}

interface QueuedUtterance {
  owner: SpeechOwner;
  utterance: SpeechSynthesisUtterance;
}

const _speech = globalSingleton(Symbol.for("sibujs.speech.v1"), () => ({
  queue: [] as QueuedUtterance[],
  active: null as QueuedUtterance | null,
  owners: new Set<SpeechOwner>(),
}));

function syncOwners(): void {
  for (const owner of Array.from(_speech.owners)) owner.sync();
}

/** Hand the next utterance whose owner is not paused to the native queue. */
function pump(synth: SpeechSynthesis): void {
  if (_speech.active) return;
  const index = _speech.queue.findIndex((entry) => !entry.owner.paused);
  if (index === -1) return;
  const [entry] = _speech.queue.splice(index, 1);
  _speech.active = entry;

  // Identity-checked: a cancelled utterance's late end/error must not advance
  // the queue a second time or clear a newer active utterance.
  const finish = () => {
    if (_speech.active !== entry) return;
    _speech.active = null;
    pump(synth);
    syncOwners();
  };
  entry.utterance.addEventListener("end", finish, { once: true });
  entry.utterance.addEventListener("error", finish, { once: true });
  synth.speak(entry.utterance);
}

/**
 * Reset the shared queue. Intended for tests only.
 *
 * @internal
 */
export function __resetSpeechCoordinator(): void {
  _speech.queue.length = 0;
  _speech.active = null;
  _speech.owners.clear();
}

/**
 * speech wraps the Web Speech Synthesis API as a reactive controller.
 * Exposes `speaking` / `paused` reactive booleans plus `speak()`, `pause()`,
 * `resume()`, `cancel()` actions.
 *
 * Controllers are isolated from each other: utterances from every controller
 * play in order, one at a time, and `cancel()`, `pause()`, `resume()` and
 * `dispose()` affect only this controller's utterances. The native
 * `speechSynthesis` queue is paused, resumed or cancelled only while one of this
 * controller's utterances is the one being spoken — and native cancellation
 * also drops utterances queued directly on `speechSynthesis` by other code.
 *
 * - `speaking()` — this controller has an utterance playing or waiting.
 * - `paused()` — this controller is paused; its waiting utterances do not start.
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
  let disposed = false;

  const owner: SpeechOwner = {
    paused: false,
    sync: () => {
      const mine = _speech.active?.owner === owner || _speech.queue.some((entry) => entry.owner === owner);
      setSpeaking(mine);
      setPaused(owner.paused);
    },
  };
  _speech.owners.add(owner);

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
    _speech.queue.push({ owner, utterance: u });
    pump(synth);
    syncOwners();
  }

  function pause(): void {
    if (disposed || owner.paused) return;
    owner.paused = true;
    if (_speech.active?.owner === owner) synth.pause();
    syncOwners();
  }

  function resume(): void {
    if (disposed || !owner.paused) return;
    owner.paused = false;
    if (_speech.active?.owner === owner) synth.resume();
    else pump(synth);
    syncOwners();
  }

  function cancel(): void {
    if (disposed) return;
    cancelOwned();
    syncOwners();
  }

  /** Drop this controller's waiting utterances and stop its active one. */
  function cancelOwned(): void {
    for (let i = _speech.queue.length - 1; i >= 0; i--) {
      if (_speech.queue[i].owner === owner) _speech.queue.splice(i, 1);
    }
    owner.paused = false;
    if (_speech.active?.owner === owner) {
      // Detach first so the native error/end fired by cancel() is ignored, then
      // continue with other controllers' utterances.
      _speech.active = null;
      if (synth.paused) synth.resume();
      synth.cancel();
      pump(synth);
    }
  }

  function dispose(): void {
    if (disposed) return;
    cancelOwned();
    disposed = true;
    syncOwners();
    _speech.owners.delete(owner);
  }

  return { speaking, paused, speak, pause, resume, cancel, dispose };
}
