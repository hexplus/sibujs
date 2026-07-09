import { signal } from "@sibujs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageLoader } from "../src/browser/imageLoader";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  private _src = "";
  static instances: FakeImage[] = [];
  constructor() {
    FakeImage.instances.push(this);
  }
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
  }
}

describe("imageLoader (coverage2)", () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades when Image is undefined", () => {
    vi.stubGlobal("Image", undefined as unknown as typeof Image);
    const img = imageLoader("/x.png");
    expect(img.status()).toBe("pending");
    expect(img.image()).toBe(null);
    expect(img.width()).toBe(0);
    expect(img.height()).toBe(0);
    expect(() => img.dispose()).not.toThrow();
  });

  it("reactive src starts a new load and abandons the prior in-flight one", () => {
    const [src, setSrc] = signal("/a.png");
    const img = imageLoader(src);
    const first = FakeImage.instances[0];
    expect(first.src).toBe("/a.png");

    // Change src -> effect re-runs, clears first.onload/onerror, starts new load
    setSrc("/b.png");
    const second = FakeImage.instances[1];
    expect(second.src).toBe("/b.png");
    // First image's handlers were detached by the re-run cleanup branch
    expect(first.onload).toBe(null);
    expect(first.onerror).toBe(null);

    // A late onload on the abandoned first image is ignored (current !== img guard)
    // (its onload was nulled, but simulate the guard via a stale handler call path)
    second.naturalWidth = 50;
    second.naturalHeight = 40;
    second.onload?.();
    expect(img.status()).toBe("loaded");
    expect(img.width()).toBe(50);
    expect(img.height()).toBe(40);
  });

  it("ignores onload from a stale image when current changed", () => {
    const [src, setSrc] = signal("/a.png");
    const img = imageLoader(src);
    const first = FakeImage.instances[0];
    // Re-point current before firing first's handler by changing src
    // Capture first.onload BEFORE re-run nulls it is not possible; instead
    // verify the start() cleanup nulls handlers (covers lines 57-59).
    setSrc("/c.png");
    expect(first.onload).toBe(null);
    expect(img.status()).toBe("pending");
  });

  it("ignores onload/onerror fired by an abandoned image (current !== img)", () => {
    const [src, setSrc] = signal("/a.png");
    const img = imageLoader(src);
    const first = FakeImage.instances[0];
    // Grab handlers before the re-run detaches them.
    const staleOnload = first.onload;
    const staleOnerror = first.onerror;
    setSrc("/b.png");
    // Re-invoke the captured stale handlers: the current !== img guard returns early.
    first.naturalWidth = 999;
    staleOnload?.();
    staleOnerror?.();
    expect(img.status()).toBe("pending");
    expect(img.width()).toBe(0);
  });

  it("dispose tears down the src effect and detaches handlers", () => {
    const [src, setSrc] = signal("/a.png");
    const img = imageLoader(src);
    const current = FakeImage.instances[FakeImage.instances.length - 1];
    img.dispose();
    expect(current.onload).toBe(null);
    expect(current.onerror).toBe(null);

    // After dispose the effect is torn down: changing src does NOT spawn a new Image
    const countBefore = FakeImage.instances.length;
    setSrc("/d.png");
    expect(FakeImage.instances.length).toBe(countBefore);
  });

  it("dispose with string src detaches current handlers", () => {
    const img = imageLoader("/string.png");
    const current = FakeImage.instances[0];
    img.dispose();
    expect(current.onload).toBe(null);
    expect(current.onerror).toBe(null);
    // calling dispose again is safe
    expect(() => img.dispose()).not.toThrow();
  });
});
