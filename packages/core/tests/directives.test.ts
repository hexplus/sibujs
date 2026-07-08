import { describe, expect, it } from "vitest";
import { match, show, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";

describe("show", () => {
  it("should toggle display based on condition", () => {
    const [visible, setVisible] = signal(true);
    const el = document.createElement("div");
    el.textContent = "Hello";

    show(() => visible(), el);

    expect(el.style.display).toBe("");

    setVisible(false);
    expect(el.style.display).toBe("none");

    setVisible(true);
    expect(el.style.display).toBe("");
  });

  it("stops reacting after the element is disposed (no subscription leak)", () => {
    const [visible, setVisible] = signal(true);
    const el = document.createElement("div");
    show(() => visible(), el);
    expect(el.style.display).toBe("");

    dispose(el);
    // After dispose the condition subscription must be gone — further changes
    // are ignored rather than leaking an effect that retains the element.
    setVisible(false);
    expect(el.style.display).toBe("");
  });
});

describe("when", () => {
  it("should render then branch when true", async () => {
    const [flag] = signal(true);
    const container = document.createElement("div");
    const anchor = when(
      () => flag(),
      () => {
        const s = document.createElement("span");
        s.textContent = "Yes";
        return s;
      },
      () => {
        const s = document.createElement("span");
        s.textContent = "No";
        return s;
      },
    );
    container.appendChild(anchor);
    document.body.appendChild(container);

    await new Promise((r) => setTimeout(r, 10));

    expect(container.textContent).toContain("Yes");

    document.body.removeChild(container);
  });

  it("stops reacting after the anchor is disposed (no subscription leak)", async () => {
    const [flag, setFlag] = signal(true);
    let renders = 0;
    const container = document.createElement("div");
    const anchor = when(
      () => flag(),
      () => {
        renders++;
        const s = document.createElement("span");
        s.textContent = "Yes";
        return s;
      },
    );
    container.appendChild(anchor);
    document.body.appendChild(container);
    await new Promise((r) => setTimeout(r, 10));
    const rendersBefore = renders;

    dispose(anchor);
    setFlag(false);
    setFlag(true);
    await new Promise((r) => setTimeout(r, 10));
    // No further re-evaluation after dispose.
    expect(renders).toBe(rendersBefore);

    document.body.removeChild(container);
  });
});

describe("match", () => {
  it("should render matching case", async () => {
    const [status] = signal<string>("loading");
    const container = document.createElement("div");
    const anchor = match(() => status(), {
      loading: () => {
        const s = document.createElement("span");
        s.textContent = "Loading...";
        return s;
      },
      done: () => {
        const s = document.createElement("span");
        s.textContent = "Done!";
        return s;
      },
    });
    container.appendChild(anchor);
    document.body.appendChild(container);

    await new Promise((r) => setTimeout(r, 10));

    expect(container.textContent).toContain("Loading...");

    document.body.removeChild(container);
  });
});
