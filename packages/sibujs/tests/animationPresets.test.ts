import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  animate,
  bounceIn,
  bounceOut,
  fadeIn,
  fadeOut,
  flipIn,
  pulse,
  scaleDown,
  scaleUp,
  sequence,
  shake,
  slideIn,
  slideOut,
  stagger,
} from "../src/ui/animationPresets";

// ---------------------------------------------------------------------------
// Web Animations API is not implemented in jsdom. We stub el.animate() to
// return a controllable fake animation whose onfinish we can invoke, so the
// orchestration helpers (animate/stagger/sequence) can resolve.
// ---------------------------------------------------------------------------

interface FakeAnimation {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish(): void;
}

let created: FakeAnimation[];

function installAnimateStub(autoFinish = true): void {
  created = [];
  HTMLElement.prototype.animate = ((
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation => {
    const anim: FakeAnimation = {
      onfinish: null,
      oncancel: null,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      finish() {
        this.onfinish?.();
      },
    };
    created.push(anim);
    if (autoFinish) {
      // Resolve on a microtask so the promise wiring is exercised.
      queueMicrotask(() => anim.finish());
    }
    return anim as unknown as Animation;
  }) as typeof HTMLElement.prototype.animate;
}

describe("animationPresets", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: false })) });
    installAnimateStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fade presets", () => {
    it("fadeIn animates opacity 0 -> 1 with defaults", () => {
      const p = fadeIn();
      expect(p.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(p.options.duration).toBe(300);
      expect(p.options.easing).toBe("ease-out");
      // createPreset defaults fill to "forwards".
      expect(p.options.fill).toBe("forwards");
    });

    it("fadeOut animates opacity 1 -> 0", () => {
      const p = fadeOut();
      expect(p.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      expect(p.options.easing).toBe("ease-in");
    });

    it("applies option overrides (duration, easing, delay, fill)", () => {
      const p = fadeIn({ duration: 1000, easing: "linear", delay: 50, fill: "both" });
      expect(p.options.duration).toBe(1000);
      expect(p.options.easing).toBe("linear");
      expect(p.options.delay).toBe(50);
      expect(p.options.fill).toBe("both");
    });
  });

  describe("slide presets", () => {
    it("slideIn defaults to the 'up' direction", () => {
      const p = slideIn();
      expect(p.keyframes[0].transform).toBe("translateY(20px)");
      expect(p.keyframes[1].transform).toBe("translate(0, 0)");
    });

    it("slideIn respects each direction offset", () => {
      expect(slideIn("down").keyframes[0].transform).toBe("translateY(-20px)");
      expect(slideIn("left").keyframes[0].transform).toBe("translateX(20px)");
      expect(slideIn("right").keyframes[0].transform).toBe("translateX(-20px)");
    });

    it("slideOut defaults to the 'down' direction and ends offset", () => {
      const p = slideOut();
      expect(p.keyframes[0].transform).toBe("translate(0, 0)");
      expect(p.keyframes[1].transform).toBe("translateY(-20px)");
    });
  });

  describe("scale presets", () => {
    it("scaleUp grows from 0.85 to 1", () => {
      const p = scaleUp();
      expect(p.keyframes[0].transform).toBe("scale(0.85)");
      expect(p.keyframes[1].transform).toBe("scale(1)");
    });

    it("scaleDown shrinks from 1 to 0.85", () => {
      const p = scaleDown();
      expect(p.keyframes[0].transform).toBe("scale(1)");
      expect(p.keyframes[1].transform).toBe("scale(0.85)");
    });
  });

  describe("bounce presets", () => {
    it("bounceIn has four keyframes with offsets", () => {
      const p = bounceIn();
      expect(p.keyframes).toHaveLength(4);
      expect(p.keyframes[1].offset).toBe(0.5);
      expect(p.keyframes[2].offset).toBe(0.7);
      expect(p.options.duration).toBe(500);
    });

    it("bounceOut has three keyframes", () => {
      const p = bounceOut();
      expect(p.keyframes).toHaveLength(3);
      expect(p.keyframes[0].transform).toBe("scale(1)");
    });
  });

  describe("flip preset", () => {
    it("flipIn defaults to the x axis (rotateX)", () => {
      const p = flipIn();
      expect(String(p.keyframes[0].transform)).toContain("rotateX(90deg)");
    });

    it("flipIn('y') uses rotateY", () => {
      const p = flipIn("y");
      expect(String(p.keyframes[0].transform)).toContain("rotateY(90deg)");
    });
  });

  describe("shake / pulse presets", () => {
    it("shake uses fill 'none' by default", () => {
      const p = shake();
      expect(p.options.fill).toBe("none");
      expect(p.keyframes.length).toBeGreaterThan(2);
    });

    it("pulse scales up and back, fill 'none'", () => {
      const p = pulse();
      expect(p.keyframes).toHaveLength(3);
      expect(p.keyframes[1].transform).toBe("scale(1.08)");
      expect(p.options.fill).toBe("none");
    });
  });

  describe("reduced motion", () => {
    it("collapses to instant (duration 0, single keyframe) when reduced motion is preferred", () => {
      vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: true })) });
      const p = fadeIn({ duration: 800 });
      expect(p.keyframes).toHaveLength(1);
      // Keeps the final keyframe.
      expect(p.keyframes[0]).toEqual({ opacity: 1 });
      expect(p.options.duration).toBe(0);
      expect(p.options.delay).toBe(0);
    });
  });

  describe("animate()", () => {
    it("calls el.animate with the preset keyframes and options and resolves on finish", async () => {
      const el = document.createElement("div");
      const preset = fadeIn();

      await animate(el, preset);

      expect(created).toHaveLength(1);
      expect(created[0].keyframes).toBe(preset.keyframes);
      expect(created[0].options).toBe(preset.options);
    });

    it("resolves when the animation is cancelled", async () => {
      installAnimateStub(false); // do not auto-finish
      const el = document.createElement("div");
      const promise = animate(el, fadeOut());

      // Trigger cancel path.
      created[0].oncancel?.();
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("stagger()", () => {
    it("animates every element and applies an incremental delay", async () => {
      installAnimateStub(false);
      const els = [document.createElement("div"), document.createElement("div"), document.createElement("div")];
      const preset = slideIn("up", { delay: 100 });

      const promise = stagger(els, preset, 50);

      expect(created).toHaveLength(3);
      expect(created[0].options.delay).toBe(100);
      expect(created[1].options.delay).toBe(150);
      expect(created[2].options.delay).toBe(200);

      // Finish all so the Promise.all resolves.
      for (const a of created) a.finish();
      await expect(promise).resolves.toBeUndefined();
    });

    it("treats a missing base delay as 0", async () => {
      installAnimateStub(false);
      const els = [document.createElement("div"), document.createElement("div")];
      const promise = stagger(els, fadeIn(), 25);

      expect(created[0].options.delay).toBe(0);
      expect(created[1].options.delay).toBe(25);

      for (const a of created) a.finish();
      await promise;
    });
  });

  describe("sequence()", () => {
    it("runs steps one after another in order", async () => {
      installAnimateStub(false);
      const el1 = document.createElement("div");
      const el2 = document.createElement("div");

      const promise = sequence([
        { el: el1, preset: fadeIn() },
        { el: el2, preset: fadeOut() },
      ]);

      // Only the first animation should have started.
      expect(created).toHaveLength(1);
      created[0].finish();
      await Promise.resolve();
      await Promise.resolve();

      // Now the second step starts.
      expect(created).toHaveLength(2);
      created[1].finish();

      await expect(promise).resolves.toBeUndefined();
    });
  });
});
