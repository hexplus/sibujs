import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSpeechCoordinator, speech } from "../src/browser/speech";

// ---------------------------------------------------------------------------
// 62. speech(): controllers own their utterances.
//
// THE DEFECT: every controller drove the global speechSynthesis queue directly.
// `dispose()`, `cancel()`, `pause()` and `resume()` called the native global
// methods, so unmounting one component cancelled — or paused — speech queued by
// every other controller and by application code.
// ---------------------------------------------------------------------------

class FakeUtterance {
  private listeners: Record<string, Array<() => void>> = {};
  constructor(readonly text: string) {}
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string) {
    const cbs = this.listeners[type] ?? [];
    this.listeners[type] = [];
    for (const cb of cbs) cb();
  }
}

function makeSynth() {
  return {
    speaking: false,
    paused: false,
    // The native queue: head is being spoken.
    queue: [] as FakeUtterance[],
    external: [] as FakeUtterance[],
    pauseCalls: 0,
    resumeCalls: 0,
    cancelCalls: 0,
    getVoices: () => [],
    speak(u: FakeUtterance) {
      this.queue.push(u);
    },
    pause() {
      this.pauseCalls++;
      this.paused = true;
    },
    resume() {
      this.resumeCalls++;
      this.paused = false;
    },
    cancel() {
      this.cancelCalls++;
      const dropped = this.queue.splice(0);
      for (const u of dropped) u.fire("error");
    },
    /** Finish the utterance at the head of the native queue. */
    finishHead() {
      const u = this.queue.shift();
      u?.fire("end");
      return u;
    },
  };
}

let synth: ReturnType<typeof makeSynth>;

beforeEach(() => {
  __resetSpeechCoordinator();
  synth = makeSynth();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance as unknown as typeof SpeechSynthesisUtterance);
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = synth;
});

afterEach(() => {
  (window as unknown as { speechSynthesis?: unknown }).speechSynthesis = undefined;
  vi.unstubAllGlobals();
});

const spokenTexts = () => synth.queue.map((u) => u.text);

describe("speech controllers are isolated", () => {
  it("disposing one controller keeps the other's queued speech", () => {
    const a = speech();
    const b = speech();
    a.speak("first");
    b.speak("second");

    a.dispose();

    // "first" was active, so it was cancelled; "second" is handed over next.
    expect(spokenTexts()).toEqual(["second"]);
    expect(b.speaking()).toBe(true);
    expect(a.speaking()).toBe(false);

    synth.finishHead();
    expect(b.speaking()).toBe(false);
  });

  it("cancelling a controller with only queued utterances does not touch native speech", () => {
    const a = speech();
    const b = speech();
    a.speak("a1");
    b.speak("b1");
    b.speak("b2");

    b.cancel();

    expect(synth.cancelCalls).toBe(0);
    expect(spokenTexts()).toEqual(["a1"]);
    synth.finishHead();
    expect(spokenTexts()).toEqual([]);
    expect(b.speaking()).toBe(false);
  });

  it("disposing an idle controller leaves externally queued utterances alone", () => {
    const external = new FakeUtterance("app code");
    synth.speak(external);
    const a = speech();

    a.dispose();

    expect(synth.cancelCalls).toBe(0);
    expect(spokenTexts()).toEqual(["app code"]);
  });

  it("utterances play in order across controllers, one at a time", () => {
    const a = speech();
    const b = speech();
    a.speak("a1");
    b.speak("b1");
    a.speak("a2");

    expect(spokenTexts()).toEqual(["a1"]);
    synth.finishHead();
    expect(spokenTexts()).toEqual(["b1"]);
    synth.finishHead();
    expect(spokenTexts()).toEqual(["a2"]);
    synth.finishHead();
    expect(a.speaking()).toBe(false);
    expect(b.speaking()).toBe(false);
  });

  it("pause and resume only affect native playback for the controller that owns it", () => {
    const a = speech();
    const b = speech();
    a.speak("a1");
    b.speak("b1");

    b.pause();
    expect(synth.pauseCalls).toBe(0);
    expect(b.paused()).toBe(true);

    a.pause();
    expect(synth.pauseCalls).toBe(1);
    expect(a.paused()).toBe(true);

    b.resume();
    expect(synth.resumeCalls).toBe(0);
    a.resume();
    expect(synth.resumeCalls).toBe(1);
    expect(a.paused()).toBe(false);
  });

  it("a paused controller's queued utterances wait while others proceed", () => {
    const a = speech();
    const b = speech();
    a.speak("a1");
    b.speak("b1");
    b.pause();
    a.speak("a2");

    synth.finishHead(); // a1 done
    expect(spokenTexts()).toEqual(["a2"]);
    synth.finishHead(); // a2 done, b still paused
    expect(spokenTexts()).toEqual([]);

    b.resume();
    expect(spokenTexts()).toEqual(["b1"]);
  });

  it("late native end/error events from a cancelled utterance change nothing", () => {
    const a = speech();
    const b = speech();
    a.speak("a1");
    const cancelled = synth.queue[0];
    b.speak("b1");

    a.cancel(); // native cancel fires error on a1, b1 starts
    expect(spokenTexts()).toEqual(["b1"]);

    cancelled.fire("end");
    cancelled.fire("error");
    expect(spokenTexts()).toEqual(["b1"]);
    expect(b.speaking()).toBe(true);
  });

  it("a disposed controller ignores later calls", () => {
    const a = speech();
    a.dispose();
    a.speak("ignored");
    a.pause();
    a.resume();
    a.cancel();
    expect(spokenTexts()).toEqual([]);
    expect(synth.pauseCalls + synth.resumeCalls + synth.cancelCalls).toBe(0);
  });
});
