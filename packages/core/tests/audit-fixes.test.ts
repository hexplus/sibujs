import { describe, expect, it } from "vitest";
import { img } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { store } from "../src/core/signals/store";
import { watch } from "../src/core/signals/watch";

describe("reactive srcset sanitization (parity with static path)", () => {
  it("splits candidates and drops dangerous URLs in a reactive srcset", () => {
    const [src, setSrc] = signal("https://ok.example/a.jpg 1x, javascript:alert(1) 2x");
    const el = img({ srcset: () => src() }) as HTMLImageElement;
    // Good candidate kept, javascript: candidate dropped (per-candidate split).
    expect(el.getAttribute("srcset")).toBe("https://ok.example/a.jpg 1x");

    setSrc("https://ok.example/b.jpg 1x, https://ok.example/c.jpg 2x");
    expect(el.getAttribute("srcset")).toBe("https://ok.example/b.jpg 1x, https://ok.example/c.jpg 2x");
  });

  it("matches the static srcset path output", () => {
    const value = "https://ok.example/a.jpg 1x, vbscript:bad 2x, /rel/d.jpg 3x";
    const reactive = img({ srcset: () => value }) as HTMLImageElement;
    const staticEl = img({ srcset: value }) as HTMLImageElement;
    expect(reactive.getAttribute("srcset")).toBe(staticEl.getAttribute("srcset"));
  });
});

describe("watch callback runs untracked", () => {
  it("a signal read inside the callback does not re-trigger the watcher", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    let calls = 0;
    watch(
      () => a(),
      () => {
        b(); // read an unrelated signal inside the callback
        calls++;
      },
    );

    setA(1); // legitimate trigger → 1 call
    expect(calls).toBe(1);

    setB(99); // must NOT trigger the watcher (callback read was untracked)
    expect(calls).toBe(1);

    setA(2);
    expect(calls).toBe(2);
  });
});

describe("store subscriptions run untracked", () => {
  it("subscribe callback reads do not leak as dependencies", () => {
    const [, actions] = store({ x: 0 });
    const [other, setOther] = signal(0);
    let calls = 0;
    actions.subscribe(() => {
      other(); // unrelated read inside the callback
      calls++;
    });

    actions.setState({ x: 1 }); // → 1 call
    expect(calls).toBe(1);

    setOther(5); // must NOT trigger the store subscriber
    expect(calls).toBe(1);

    actions.setState({ x: 2 });
    expect(calls).toBe(2);
  });

  it("subscribeKey callback reads do not leak as dependencies", () => {
    const [, actions] = store({ count: 0, name: "a" });
    const [other, setOther] = signal(0);
    let calls = 0;
    actions.subscribeKey("count", () => {
      other();
      calls++;
    });

    actions.setState({ count: 1 });
    expect(calls).toBe(1);

    setOther(7); // must NOT re-fire
    expect(calls).toBe(1);
  });
});
