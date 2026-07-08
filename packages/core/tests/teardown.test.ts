import { describe, expect, it, vi } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { watch } from "../src/core/signals/watch";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { bindChildNode } from "../src/reactivity/bindChildNode";
import { bindTextNode } from "../src/reactivity/bindTextNode";

describe("Reactivity teardown safety", () => {
  it("effect should stop running after teardown", () => {
    const [count, setCount] = signal(0);
    const spy = vi.fn();

    // mount effect
    const teardown = effect(() => {
      spy(count());
    });

    // initial run
    expect(spy).toHaveBeenCalledTimes(1);
    setCount(1);
    expect(spy).toHaveBeenCalledTimes(2);

    // unmount effect
    teardown();
    setCount(2);
    expect(spy).toHaveBeenCalledTimes(2); // no new calls
  });

  it("derived should not recalc after teardown of its dependent watcher", () => {
    const [a, setA] = signal(1);
    const comp = derived(() => a() * 2);
    const spy = vi.fn(() => comp());

    // create a watcher around comp
    const teardown = watch(comp, () => spy());

    // trigger recompute
    setA(2);
    expect(spy).toHaveBeenCalled(); // at least once

    // teardown
    teardown();
    setA(3);
    // spy should not be called again
    const calls = spy.mock.calls.length;
    setA(4);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("bindAttribute should stop updating after teardown", () => {
    const [val, setVal] = signal("foo");
    const el = document.createElement("div");

    // bind class attribute
    const teardown = bindAttribute(el, "class", () => val());
    expect(el.getAttribute("class")).toBe("foo");

    setVal("bar");
    expect(el.getAttribute("class")).toBe("bar");

    // teardown binding
    teardown();
    setVal("baz");
    expect(el.getAttribute("class")).toBe("bar");
  });

  it("bindTextNode should stop updating after teardown", () => {
    const [txt, setTxt] = signal("hello");
    const node = document.createTextNode("");
    const teardown = bindTextNode(node, () => txt());

    expect(node.textContent).toBe("hello");
    setTxt("world");
    expect(node.textContent).toBe("world");

    teardown();
    setTxt("!");
    expect(node.textContent).toBe("world");
  });

  it("bindChildNode should stop updating after teardown", () => {
    const [flag, setFlag] = signal(true);
    const placeholder = document.createComment("ph");
    const container = document.createElement("div");
    container.appendChild(placeholder);

    // bind a child node that toggles between a <span> and null
    const teardown = bindChildNode(placeholder, () => {
      return flag() ? document.createElement("span") : null;
    });

    // initial mount
    expect(container.querySelector("span")).toBeTruthy();

    setFlag(false);
    expect(container.querySelector("span")).toBeNull();

    // teardown
    teardown();
    setFlag(true);
    expect(container.querySelector("span")).toBeNull();
  });

  it("multiple mount/unmount cycles do not leak", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    let teardown: () => void;

    for (let i = 0; i < 3; i++) {
      teardown = effect(() => {
        spy(n());
      });
      setN(i + 1);
      teardown?.(); // unmount immediately
    }

    // spy should have been called exactly 3 (initial) + 3 (updates) = 6 times
    expect(spy).toHaveBeenCalledTimes(6);

    // further updates should not trigger any new calls
    setN(99);
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
