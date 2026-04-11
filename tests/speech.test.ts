import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speech } from "../src/browser/speech";

describe("speech", () => {
  let synth: {
    speaking: boolean;
    paused: boolean;
    speak: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    getVoices: () => SpeechSynthesisVoice[];
  };
  let UtteranceCtor: ReturnType<typeof vi.fn>;
  let createdUtterances: Array<{
    text: string;
    rate?: number;
    lang?: string;
    addEventListener: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    synth = {
      speaking: false,
      paused: false,
      speak: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      getVoices: () => [],
    };
    createdUtterances = [];
    UtteranceCtor = vi.fn(function (this: Record<string, unknown>, text: string) {
      const utt = {
        text,
        addEventListener: vi.fn(),
      } as unknown as {
        text: string;
        addEventListener: ReturnType<typeof vi.fn>;
      };
      createdUtterances.push(utt);
      Object.assign(this, utt);
    });

    vi.stubGlobal("window", {
      speechSynthesis: synth,
      SpeechSynthesisUtterance: UtteranceCtor,
    });
    vi.stubGlobal("SpeechSynthesisUtterance", UtteranceCtor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls synth.speak on speak()", () => {
    const tts = speech();
    tts.speak("hi");
    expect(synth.speak).toHaveBeenCalled();
    tts.dispose();
  });

  it("pause/resume/cancel forward to the synth", () => {
    const tts = speech();
    tts.pause();
    tts.resume();
    tts.cancel();
    expect(synth.pause).toHaveBeenCalled();
    expect(synth.resume).toHaveBeenCalled();
    expect(synth.cancel).toHaveBeenCalled();
    tts.dispose();
  });

  it("gracefully handles missing speechSynthesis", () => {
    vi.stubGlobal("window", {});
    const tts = speech();
    expect(tts.speaking()).toBe(false);
    tts.speak("hi"); // no-op
    tts.dispose();
  });
});
