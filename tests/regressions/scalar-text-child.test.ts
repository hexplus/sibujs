// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { when } from "../../src/core/rendering/directives";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import type { NodeChild } from "../../src/core/rendering/types";
import { signal } from "../../src/core/signals/signal";
import { hydrate } from "../../src/platform/ssr";
import { renderToStringAsync } from "../../src/platform/ssrAsync";
import { bindChildNode } from "../../src/reactivity/bindChildNode";
import { bindTextNode } from "../../src/reactivity/bindTextNode";

afterEach(() => {
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
});

function watch(target: Node) {
  const observer = new MutationObserver(() => {});
  observer.observe(target, { childList: true, characterData: true, subtree: true });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return {
      childList: records.filter((r) => r.type === "childList").length,
      characterData: records.filter((r) => r.type === "characterData").length,
    };
  };
}

/** `div(getter)` attached to the document, with its placeholder. */
function rendered(getter: () => NodeChild | NodeChild[]) {
  const el = div(getter as () => NodeChild);
  document.body.appendChild(el);
  return { el, placeholder: el.firstChild as Comment };
}

describe("scalar reactive children", () => {
  it("updates one text node in place when the value changes", () => {
    const [count, setCount] = signal(0);
    const { el, placeholder } = rendered(() => count());
    const text = placeholder.nextSibling;
    const records = watch(el);

    for (let i = 1; i <= 1000; i++) setCount(i);

    expect(records()).toEqual({ childList: 0, characterData: 1000 });
    expect(placeholder.nextSibling).toBe(text);
    expect(el.textContent).toBe("1000");
  });

  it("touches nothing when the displayed text stays equal", () => {
    const [count, setCount] = signal(0);
    const { el } = rendered(() => (count() < 0 ? "negative" : "positive"));
    const records = watch(el);

    for (let i = 1; i <= 100; i++) setCount(i);

    expect(records()).toEqual({ childList: 0, characterData: 0 });
    expect(el.textContent).toBe("positive");
  });

  it("compares the serialized value, so a number and its string are equal", () => {
    const [value, setValue] = signal<string | number>(1);
    const { el } = rendered(() => value());
    const records = watch(el);

    setValue("1");
    expect(records()).toEqual({ childList: 0, characterData: 0 });

    setValue("");
    expect(el.textContent).toBe("");
    setValue(0);
    expect(el.textContent).toBe("0");
  });

  it("goes from text to an element and back, disposing the element", () => {
    let released = 0;
    const [value, setValue] = signal<"text" | "node" | "again">("text");
    const child = span("element");
    registerDisposer(child, () => released++);
    const { el, placeholder } = rendered(() => (value() === "node" ? child : value()));
    const first = placeholder.nextSibling;

    setValue("node");
    expect(el.textContent).toBe("element");
    expect(placeholder.nextSibling).toBe(child);
    expect(first?.parentNode).toBeNull();

    setValue("again");
    expect(el.textContent).toBe("again");
    expect(child.parentNode).toBeNull();
    expect(released).toBe(1);
    expect(el.childNodes.length).toBe(2);
  });

  it("goes from text to nothing and back", () => {
    const [value, setValue] = signal<string | null | boolean>("a");
    const { el } = rendered(() => value());

    setValue(null);
    expect(el.childNodes.length).toBe(1);
    setValue("b");
    expect(el.textContent).toBe("b");
    expect(el.childNodes.length).toBe(2);
    setValue(false);
    expect(el.childNodes.length).toBe(1);
    setValue("c");
    expect(el.textContent).toBe("c");
  });

  it("goes from text to an array and back", () => {
    const [value, setValue] = signal<string | string[]>("a");
    const { el } = rendered(() => value());

    setValue(["b", "c"]);
    expect(el.textContent).toBe("bc");
    expect(el.childNodes.length).toBe(3);
    setValue("d");
    expect(el.textContent).toBe("d");
    expect(el.childNodes.length).toBe(2);
  });

  it("never writes to a Text node the application returned", () => {
    const own = document.createTextNode("mine");
    const [value, setValue] = signal<string | Text>(own);
    const { el, placeholder } = rendered(() => value());
    expect(placeholder.nextSibling).toBe(own);

    setValue("scalar");

    expect(own.data).toBe("mine");
    expect(own.parentNode).toBeNull();
    expect(el.textContent).toBe("scalar");
  });

  it("keeps the last text through a throwing getter and resumes on the same node", () => {
    setRuntimeErrorHandler(() => {});
    const [value, setValue] = signal("a");
    const { el, placeholder } = rendered(() => {
      if (value() === "boom") throw new Error("boom");
      return value();
    });
    const text = placeholder.nextSibling;

    setValue("boom");
    expect(el.textContent).toBe("a");

    setValue("b");
    expect(el.textContent).toBe("b");
    expect(placeholder.nextSibling).toBe(text);
  });

  it("puts the text back when something else removed it", () => {
    const [value, setValue] = signal("a");
    const { el, placeholder } = rendered(() => value());

    (placeholder.nextSibling as Text).remove();
    setValue("b");

    expect(el.textContent).toBe("b");
    expect(placeholder.nextSibling?.nodeValue).toBe("b");
  });

  it("restores an equal value when something else changed the node", () => {
    const [value, setValue] = signal("a");
    const [other, setOther] = signal(0);
    const { el, placeholder } = rendered(() => {
      other();
      return value();
    });

    (placeholder.nextSibling as Text).data = "edited";
    setOther(1);

    expect(el.textContent).toBe("a");
    setValue("b");
    expect(el.textContent).toBe("b");
  });

  it("keeps each binding on its own node among siblings", () => {
    const [a, setA] = signal("a");
    const [b, setB] = signal("b");
    const el = div([() => a(), span("|"), () => b()]);
    const records = watch(el);

    setA("A");
    setB("B");

    expect(el.textContent).toBe("A|B");
    expect(records()).toEqual({ childList: 0, characterData: 2 });
  });

  it("stops writing once its owner is disposed", () => {
    const [value, setValue] = signal("a");
    const { el, placeholder } = rendered(() => value());
    const text = placeholder.nextSibling as Text;

    dispose(el);
    setValue("b");

    expect(text.data).toBe("a");
  });

  it("does not write when the getter disposes the binding on a later run", () => {
    const host = document.createElement("div");
    const placeholder = document.createComment("");
    host.appendChild(placeholder);
    const [value, setValue] = signal("a");
    let stop: () => void = () => {};
    stop = bindChildNode(placeholder, () => {
      if (value() === "stop") stop();
      return value();
    });
    const text = placeholder.nextSibling as Text;

    setValue("stop");

    expect(text.data).toBe("a");
  });

  it("is still released with a directive branch when rendered through a Fragment", async () => {
    const tick = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const [show, setShow] = signal(true);
    const [value, setValue] = signal("a");
    const host = div([when(show, () => Fragment([() => value()]))]);
    document.body.appendChild(host);
    await tick();

    setValue("b");
    await tick();
    expect(host.textContent).toBe("b");

    setShow(false);
    await tick();
    expect(host.textContent).toBe("");

    setValue("c");
    await tick();
    expect(host.textContent).toBe("");
  });

  it("keeps the adopted text node after an adopting hydration", async () => {
    const [value, setValue] = signal("first");
    const app = () => div({ class: "root" }, () => value());
    const { html } = await renderToStringAsync(app, { hydration: "adopt" });
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    await hydrate(app, container, { strategy: "adopt" });

    const root = container.querySelector(".root") as HTMLElement;
    expect(root.textContent).toBe("first");
    const text = Array.from(root.childNodes).find((n) => n.nodeType === 3);
    const records = watch(root);

    setValue("second");

    expect(root.textContent).toBe("second");
    expect(Array.from(root.childNodes).find((n) => n.nodeType === 3)).toBe(text);
    expect(records()).toEqual({ childList: 0, characterData: 1 });
  });
});

describe("bindTextNode", () => {
  it("writes only when the displayed text changes", () => {
    const text = document.createTextNode("");
    const [count, setCount] = signal(0);
    const stop = bindTextNode(text, () => (count() < 2 ? "low" : "high"));
    const host = document.createElement("div");
    host.appendChild(text);
    const records = watch(host);

    setCount(1);
    expect(records()).toEqual({ childList: 0, characterData: 0 });

    const changed = watch(host);
    setCount(2);
    expect(changed().characterData).toBeGreaterThan(0);
    expect(text.data).toBe("high");
    stop();
  });
});
