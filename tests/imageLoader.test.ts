import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageLoader } from "../src/browser/imageLoader";

describe("imageLoader", () => {
  let instances: Array<{
    onload: (() => void) | null;
    onerror: (() => void) | null;
    src: string;
    naturalWidth: number;
    naturalHeight: number;
  }>;

  beforeEach(() => {
    instances = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      naturalWidth = 0;
      naturalHeight = 0;
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts in pending state", () => {
    const img = imageLoader("/x.png");
    expect(img.status()).toBe("pending");
    expect(img.image()).toBe(null);
  });

  it("resolves to loaded on onload with natural dimensions", () => {
    const img = imageLoader("/x.png");
    const inst = instances[instances.length - 1];
    inst.naturalWidth = 300;
    inst.naturalHeight = 200;
    inst.onload?.();
    expect(img.status()).toBe("loaded");
    expect(img.width()).toBe(300);
    expect(img.height()).toBe(200);
  });

  it("transitions to error on failure", () => {
    const img = imageLoader("/missing.png");
    const inst = instances[instances.length - 1];
    inst.onerror?.();
    expect(img.status()).toBe("error");
    expect(img.image()).toBe(null);
  });

  it("dispose ignores subsequent callbacks", () => {
    const img = imageLoader("/x.png");
    const inst = instances[instances.length - 1];
    img.dispose();
    inst.naturalWidth = 100;
    inst.onload?.();
    expect(img.status()).toBe("pending");
  });
});
