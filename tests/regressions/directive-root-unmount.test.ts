import { describe, expect, it } from "vitest";
import { match, show, when } from "../../src/core/rendering/directives";
import { each } from "../../src/core/rendering/each";
import { div, span } from "../../src/core/rendering/html";
import { mount } from "../../src/core/rendering/mount";
import { signal } from "../../src/core/signals/signal";

/** Let the directives' deferred first render run. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("unmounting a directive root (BUGS.md B1)", () => {
  it("regression: unmount() of a when() root empties the container", async () => {
    const host = document.createElement("div");
    const [visible, setVisible] = signal(true);
    const handle = mount(
      () =>
        when(
          () => visible(),
          () => div("branch"),
        ),
      host,
    );
    await flush();
    expect(host.textContent).toBe("branch");
    handle.unmount();
    expect(host.childNodes.length).toBe(0);
    // A later write neither recreates nor updates the content.
    setVisible(false);
    setVisible(true);
    await flush();
    expect(host.childNodes.length).toBe(0);
  });

  it("regression: unmount() of a match() root empties the container", async () => {
    const host = document.createElement("div");
    const [key, setKey] = signal<"a" | "b">("a");
    const handle = mount(() => match(() => key(), { a: () => div("M"), b: () => div("N") }), host);
    await flush();
    expect(host.textContent).toBe("M");
    handle.unmount();
    expect(host.childNodes.length).toBe(0);
    setKey("b");
    await flush();
    expect(host.childNodes.length).toBe(0);
  });

  it("regression: unmount() of an each() root empties the container", async () => {
    const host = document.createElement("div");
    const [items, setItems] = signal([1, 2, 3]);
    const handle = mount(
      () =>
        each(
          () => items(),
          (n) => div(() => String(n())),
          { key: (n) => n },
        ),
      host,
    );
    await flush();
    expect(host.textContent).toBe("123");
    handle.unmount();
    expect(host.childNodes.length).toBe(0);
    setItems([4, 5]);
    await flush();
    expect(host.childNodes.length).toBe(0);
  });

  it("regression: the branch's own bindings are released by unmount()", async () => {
    const host = document.createElement("div");
    const [label, setLabel] = signal("x");
    let reads = 0;
    const handle = mount(
      () =>
        when(
          () => true,
          () =>
            span(() => {
              reads++;
              return label();
            }),
        ),
      host,
    );
    await flush();
    const before = reads;
    handle.unmount();
    setLabel("y");
    expect(reads).toBe(before);
  });

  it("control: an element root (show) is still removed", () => {
    const host = document.createElement("div");
    const [s] = signal(true);
    const handle = mount(() => show(() => s(), div("S")), host);
    handle.unmount();
    expect(host.childNodes.length).toBe(0);
  });

  it("a directive root keeps rendering after mount, before unmount", async () => {
    const host = document.createElement("div");
    const [visible, setVisible] = signal(true);
    mount(
      () =>
        when(
          () => visible(),
          () => div("A"),
          () => div("B"),
        ),
      host,
    );
    await flush();
    setVisible(false);
    expect(host.textContent).toBe("B");
  });
});

describe("a directive used as another directive's branch", () => {
  it("regression: switching the outer when() away removes the inner directive's content", async () => {
    const host = document.createElement("div");
    const [outer, setOuter] = signal(true);
    mount(
      () =>
        div([
          when(
            () => outer(),
            () =>
              when(
                () => true,
                () => span("inner"),
              ),
            () => span("other"),
          ),
        ]),
      host,
    );
    await flush();
    await flush();
    expect(host.textContent).toBe("inner");
    setOuter(false);
    await flush();
    expect(host.textContent).toBe("other");
  });

  it("regression: a match() case that is itself a when() is removed on a key change", async () => {
    const host = document.createElement("div");
    const [key, setKey] = signal<"a" | "b">("a");
    mount(
      () =>
        div([
          match(() => key(), {
            a: () =>
              when(
                () => true,
                () => span("A"),
              ),
            b: () => span("B"),
          }),
        ]),
      host,
    );
    await flush();
    await flush();
    expect(host.textContent).toBe("A");
    setKey("b");
    await flush();
    expect(host.textContent).toBe("B");
  });
});
