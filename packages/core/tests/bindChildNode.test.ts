import { beforeEach, describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindChildNode } from "../src/reactivity/bindChildNode";

let parent: HTMLElement;
let placeholder: Comment;

beforeEach(() => {
  parent = document.createElement("div");
  placeholder = document.createComment("placeholder");
  parent.appendChild(placeholder);
});

describe("bindChildNode - basic behavior", () => {
  it("should insert and remove a DOM element based on condition", () => {
    const [visible, setVisible] = signal(true);

    bindChildNode(placeholder, () => (visible() ? document.createElement("span") : null));

    // initial render
    const span1 = parent.querySelector("span");

    expect(span1).toBeTruthy();

    // removal
    setVisible(false);
    expect(parent.querySelector("span")).toBeFalsy();

    // re-insert
    setVisible(true);
    const span2 = parent.querySelector("span");

    expect(span2).toBeTruthy();
  });

  it("should insert text node when string is returned", () => {
    const [name, setName] = signal("Initial");

    bindChildNode(placeholder, () => name());

    expect(parent.textContent).toBe("Initial");

    setName("Updated");
    expect(parent.textContent).toBe("Updated");
  });

  it("should render correctly on first mount", () => {
    const [message] = signal("Ready");

    bindChildNode(placeholder, () => message());

    expect(parent.textContent).toBe("Ready");
  });
});

// More robust scenarios

describe("bindChildNode - advanced scenarios", () => {
  it("should handle returning an array of nodes", () => {
    const [count, setCount] = signal(1);
    bindChildNode(placeholder, () => {
      const nodes: Node[] = [];
      for (let i = 0; i < count(); i++) {
        const el = document.createElement("div");
        el.textContent = `Item ${i}`;
        nodes.push(el);
      }
      return nodes;
    });

    const items1 = parent.querySelectorAll("div");
    expect(items1.length).toBe(1);
    expect(parent.textContent).toBe("Item 0");

    setCount(3);
    const items2 = parent.querySelectorAll("div");
    expect(items2.length).toBe(3);
    expect(items2[2].textContent).toBe("Item 2");
  });

  it("should clear previous nodes before inserting new ones", () => {
    const [flag, setFlag] = signal(true);
    bindChildNode(placeholder, () => {
      return flag() ? document.createElement("p") : document.createElement("section");
    });

    const p1 = parent.querySelector("p");
    expect(p1).toBeTruthy();

    setFlag(false);
    expect(parent.querySelector("p")).toBeNull();
    expect(parent.querySelector("section")).toBeTruthy();
  });

  it("should swallow errors in render function and leave DOM unchanged", () => {
    const [count, setCount] = signal(0);
    // render throws when count is even
    bindChildNode(placeholder, () => {
      if (count() % 2 === 0) throw new Error("Test error");
      const el = document.createElement("span");
      el.textContent = `Count ${count()}`;
      return el;
    });

    // First mount (count = 0) throws, so nothing should be inserted
    expect(parent.querySelector("span")).toBeNull();

    setCount(1);
    const spanAfter1 = parent.querySelector("span");

    expect(spanAfter1).toBeTruthy();
    expect(spanAfter1?.textContent).toBe("Count 1");

    setCount(2);
    // throws again, should retain last successful state
    const spanAfter2 = parent.querySelector("span");

    expect(spanAfter2).toBeTruthy();
    expect(spanAfter2?.textContent).toBe("Count 1");
  });

  it("should support nested bindChildNode calls", () => {
    const [outer, setOuter] = signal(true);
    const [inner, setInner] = signal("A");

    bindChildNode(placeholder, () => {
      if (!outer()) return null;
      const container = document.createElement("div");
      const innerPlaceholder = document.createComment("inner");
      container.appendChild(innerPlaceholder);

      bindChildNode(innerPlaceholder, () => inner());
      return container;
    });

    const div1 = parent.querySelector("div");

    expect(div1).toBeTruthy();
    expect(div1?.textContent).toBe("A");

    setInner("B");
    const div2 = parent.querySelector("div");

    expect(div2).toBeTruthy();
    expect(div2?.textContent).toBe("B");

    setOuter(false);
    expect(parent.querySelector("div")).toBeNull();
  });
});
