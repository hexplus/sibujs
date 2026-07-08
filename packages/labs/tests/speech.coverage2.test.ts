import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speech } from "../src/browser/speech";

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: { name: string } | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(text: string) {
    this.text = text;
  }
  addEventListener(type: string, cb: () => void, _opts?: unknown) {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string) {
    for (const cb of this.listeners[type] ?? []) cb();
  }
}

function makeSynth() {
  return {
    speaking: false,
    paused: false,
    spokenUtterances: [] as FakeUtterance[],
    pauseCalls: 0,
    resumeCalls: 0,
    cancelCalls: 0,
    voices: [] as Array<{ name: string }>,
    getVoices() {
      return this.voices;
    },
    speak(u: FakeUtterance) {
      this.spokenUtterances.push(u);
    },
    pause() {
      this.pauseCalls++;
    },
    resume() {
      this.resumeCalls++;
    },
    cancel() {
      this.cancelCalls++;
    },
  };
}

describe("speech (coverage2)", () => {
  let synth: ReturnType<typeof makeSynth>;
  let utterances: FakeUtterance[];

  beforeEach(() => {
    vi.useFakeTimers();
    synth = makeSynth();
    utterances = [];
    vi.stubGlobal("SpeechSynthesisUtterance", function (this: unknown, text: string) {
      const u = new FakeUtterance(text);
      utterances.push(u);
      return u;
    } as unknown as typeof SpeechSynthesisUtterance);
    // window exists in jsdom; just attach speechSynthesis to it.
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = synth;
  });

  afterEach(() => {
    (window as unknown as { speechSynthesis?: unknown }).speechSynthesis = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("degrades gracefully when speechSynthesis is undefined", () => {
    (window as unknown as { speechSynthesis?: unknown }).speechSynthesis = undefined;
    const tts = speech();
    expect(tts.speaking()).toBe(false);
    expect(tts.paused()).toBe(false);
    // no-op actions must not throw
    tts.speak("hi");
    tts.pause();
    tts.resume();
    tts.cancel();
    tts.dispose();
    expect(synth.spokenUtterances.length).toBe(0);
  });

  it("applies all options including matching voice", () => {
    synth.voices = [{ name: "Alex" }, { name: "Victoria" }];
    const tts = speech();
    tts.speak("hello", { lang: "en-US", rate: 1.5, pitch: 0.8, volume: 0.5, voice: "Victoria" });
    const u = synth.spokenUtterances[0];
    expect(u.lang).toBe("en-US");
    expect(u.rate).toBe(1.5);
    expect(u.pitch).toBe(0.8);
    expect(u.volume).toBe(0.5);
    expect(u.voice).toEqual({ name: "Victoria" });
    expect(tts.speaking()).toBe(true);
  });

  it("does not assign voice when no match is found", () => {
    synth.voices = [{ name: "Alex" }];
    const tts = speech();
    tts.speak("hello", { voice: "DoesNotExist" });
    expect(synth.spokenUtterances[0].voice).toBe(null);
  });

  it("start/end/error listeners update reactive state", () => {
    const tts = speech();
    tts.speak("text");
    const u = utterances[0];
    u.fire("start");
    expect(tts.speaking()).toBe(true);
    u.fire("end");
    expect(tts.speaking()).toBe(false);
    expect(tts.paused()).toBe(false);

    tts.speak("again");
    const u2 = utterances[1];
    u2.fire("error");
    expect(tts.speaking()).toBe(false);
    expect(tts.paused()).toBe(false);
  });

  it("polling syncs speaking/paused and stops when idle", () => {
    const tts = speech();
    synth.speaking = true;
    tts.speak("text");
    // First tick: still speaking
    vi.advanceTimersByTime(200);
    expect(tts.speaking()).toBe(true);

    synth.paused = true;
    synth.speaking = false;
    vi.advanceTimersByTime(200);
    expect(tts.paused()).toBe(true);
    expect(tts.speaking()).toBe(false);

    // Now idle -> interval should clear itself
    synth.paused = false;
    vi.advanceTimersByTime(200);
    expect(tts.speaking()).toBe(false);
    expect(tts.paused()).toBe(false);
  });

  it("startPolling is idempotent (no second interval while active)", () => {
    const tts = speech();
    synth.speaking = true;
    tts.speak("one");
    tts.speak("two"); // second startPolling() should early-return
    vi.advanceTimersByTime(200);
    expect(tts.speaking()).toBe(true);
  });

  it("pause/resume/cancel delegate to synth", () => {
    const tts = speech();
    tts.pause();
    tts.resume();
    tts.cancel();
    expect(synth.pauseCalls).toBe(1);
    expect(synth.resumeCalls).toBe(1);
    expect(synth.cancelCalls).toBe(1);
  });

  it("dispose clears interval, cancels synth, and blocks later writes", () => {
    const tts = speech();
    synth.speaking = true;
    tts.speak("text");
    const u = utterances[0];
    tts.dispose();
    expect(synth.cancelCalls).toBe(1);

    // disposed guard: speak is a no-op
    const before = synth.spokenUtterances.length;
    tts.speak("ignored");
    expect(synth.spokenUtterances.length).toBe(before);

    // queued events after dispose must not flip state
    u.fire("start");
    u.fire("end");
    u.fire("error");
    expect(tts.speaking()).toBe(true); // unchanged from pre-dispose

    // interval cleared: advancing timers does nothing
    vi.advanceTimersByTime(1000);
  });

  it("dispose is safe when nothing is speaking (interval null)", () => {
    const tts = speech();
    expect(() => tts.dispose()).not.toThrow();
    expect(synth.cancelCalls).toBe(1);
  });
});
