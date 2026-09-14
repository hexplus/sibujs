import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageLoader } from "../src/browser/imageLoader";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// imageLoader() never exposes metadata from a previous image.
//
// THE DEFECT: starting a new load reset `status` and `image` but not `width` /
// `height`, so while the next source was pending — and forever if it failed —
// the loader reported the previous image's dimensions. `dispose()` was
// documented to reset state but left every signal untouched, and an abandoned
// in-flight request only had its handlers detached.
// ---------------------------------------------------------------------------

interface FakeImg {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  srcHistory: string[];
}

let instances: FakeImg[];

beforeEach(() => {
  instances = [];
  class FakeImage implements FakeImg {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    srcHistory: string[] = [];
    private _src = "";
    get src() {
      return this._src;
    }
    set src(value: string) {
      this._src = value;
      this.srcHistory.push(value);
    }
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function load(inst: FakeImg, width: number, height: number): void {
  inst.naturalWidth = width;
  inst.naturalHeight = height;
  inst.onload?.();
}

describe("imageLoader source changes", () => {
  it("loaded A → pending B → failed B exposes nothing from A", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    load(instances[0], 800, 600);
    expect(loader.width()).toBe(800);

    setSrc("/second.png");
    expect(loader.status()).toBe("pending");
    expect(loader.image()).toBeNull();
    expect(loader.width()).toBe(0);
    expect(loader.height()).toBe(0);

    instances[1].onerror?.();
    expect(loader.status()).toBe("error");
    expect(loader.image()).toBeNull();
    expect(loader.width()).toBe(0);
    expect(loader.height()).toBe(0);
    loader.dispose();
  });

  it("loaded A → loaded B reports B's dimensions", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    load(instances[0], 800, 600);

    setSrc("/second.png");
    load(instances[1], 40, 30);

    expect(loader.status()).toBe("loaded");
    expect(loader.image()).toBe(instances[1]);
    expect(loader.width()).toBe(40);
    expect(loader.height()).toBe(30);
    loader.dispose();
  });

  it("an observer never sees a pending status paired with the previous dimensions", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    load(instances[0], 800, 600);

    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(`${loader.status()}:${loader.width()}x${loader.height()}`);
    });
    seen.length = 0;

    setSrc("/second.png");

    expect(seen).toEqual(["pending:0x0"]);
    stop();
    loader.dispose();
  });

  it("best-effort cancels an abandoned in-flight request", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    const first = instances[0];

    setSrc("/second.png");

    expect(first.onload).toBeNull();
    expect(first.onerror).toBeNull();
    expect(first.srcHistory).toEqual(["/first.png", ""]);
    loader.dispose();
  });

  it("does not clear the src of an image that already loaded", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    const first = instances[0];
    load(first, 800, 600);

    setSrc("/second.png");

    // A caller may still hold (and display) the loaded element.
    expect(first.src).toBe("/first.png");
    loader.dispose();
  });
});

describe("imageLoader dispose", () => {
  it("loaded → dispose resets every signal", () => {
    const loader = imageLoader("/x.png");
    load(instances[0], 300, 200);
    expect(loader.status()).toBe("loaded");

    loader.dispose();

    expect(loader.status()).toBe("pending");
    expect(loader.image()).toBeNull();
    expect(loader.width()).toBe(0);
    expect(loader.height()).toBe(0);
  });

  it("dispose during a load cancels it and ignores its late result", () => {
    const loader = imageLoader("/x.png");
    const inst = instances[0];

    loader.dispose();
    expect(inst.srcHistory).toEqual(["/x.png", ""]);

    inst.naturalWidth = 300;
    inst.naturalHeight = 200;
    inst.onload?.();
    expect(loader.status()).toBe("pending");
    expect(loader.width()).toBe(0);
  });

  it("dispose stops reacting to src changes and is idempotent", () => {
    const [src, setSrc] = signal("/first.png");
    const loader = imageLoader(src);
    load(instances[0], 800, 600);

    loader.dispose();
    loader.dispose();
    setSrc("/second.png");

    expect(instances).toHaveLength(1);
    expect(loader.width()).toBe(0);
  });
});
