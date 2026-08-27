import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { title } from "../src/browser/title";
import { signal } from "../src/core/signals/signal";

describe("title", () => {
  let originalTitle: string;

  beforeEach(() => {
    originalTitle = document.title;
    document.title = "Initial Title";
  });

  afterEach(() => {
    document.title = originalTitle;
  });

  it("sets document title with a static string", () => {
    // Released at the end: title ownership is a shared stack, so a leaked
    // owner stays on it and the next test's release hands the title back to
    // THIS one instead of to the document's original.
    const dispose = title("My Page");
    expect(document.title).toBe("My Page");
    dispose();
  });

  it("restores previous title on dispose", () => {
    const dispose = title("New Title");
    expect(document.title).toBe("New Title");

    dispose();
    expect(document.title).toBe("Initial Title");
  });

  it("sets document title reactively from a getter", () => {
    const [getTitle, setTitle] = signal("Reactive Title");
    const dispose = title(getTitle);

    expect(document.title).toBe("Reactive Title");

    setTitle("Updated Title");
    expect(document.title).toBe("Updated Title");
    dispose();
  });

  it("restores previous title on dispose with reactive getter", () => {
    const [getT] = signal("Reactive Title");
    const dispose = title(getT);

    expect(document.title).toBe("Reactive Title");

    dispose();
    expect(document.title).toBe("Initial Title");
  });
});
