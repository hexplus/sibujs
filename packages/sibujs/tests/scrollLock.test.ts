import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrollLock } from "../src/ui/scrollLock";

describe("scrollLock", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
  });

  afterEach(() => {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
  });

  it("applies overflow:hidden on lock", () => {
    const h = scrollLock();
    h.lock();
    expect(document.body.style.overflow).toBe("hidden");
    h.unlock();
  });

  it("restores overflow after all locks release", () => {
    const a = scrollLock();
    const b = scrollLock();
    a.lock();
    b.lock();
    expect(document.body.style.overflow).toBe("hidden");
    a.unlock();
    expect(document.body.style.overflow).toBe("hidden"); // still locked by b
    b.unlock();
    expect(document.body.style.overflow).toBe("");
  });

  it("lock is idempotent per-handle", () => {
    const a = scrollLock();
    a.lock();
    a.lock();
    a.unlock();
    expect(document.body.style.overflow).toBe("");
  });

  it("preserves existing overflow style across lock/unlock", () => {
    document.body.style.overflow = "scroll";
    const h = scrollLock();
    h.lock();
    expect(document.body.style.overflow).toBe("hidden");
    h.unlock();
    expect(document.body.style.overflow).toBe("scroll");
  });
});
