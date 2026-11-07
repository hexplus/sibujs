import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { type PendingContent, pendingContent } from "../src/core/rendering/pendingContent";
import { pendingCount } from "../src/core/rendering/range";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// While an enter waits for content, moving a registered node into or out of
// the entering branch changes what it waits for — observed on the branch,
// not inferred at the next registration change. A registration whose node
// joined the branch and settled in the same task still enrolls its content,
// though it has already left the global pending set. Once the window closed,
// nothing reopens it.
// ---------------------------------------------------------------------------

let host: HTMLElement;
// Registrations an earlier test left unsettled (a detached node nobody
// settles) stay registered by design; counts are taken relative to this.
let base = 0;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".in { animation-name: rise; animation-duration: 0.2s; }";
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  base = pendingCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const q = (selector: string) => host.querySelector(selector);
const entering = () => host.querySelectorAll(".in").length;

/** A detached `.slot` with a registration on it, made before any enter. */
function detachedSlot() {
  const slot = div({ class: "slot" }, span({ class: "slot-placeholder" }, "…"));
  return { slot, pending: pendingContent(slot) };
}

describe("class-based enter", () => {
  /** Heading + region; the region's registration keeps the window open. */
  async function open() {
    let hold!: PendingContent;
    const [on, setOn] = signal(false);
    host.appendChild(
      when(
        on,
        () => {
          const region = div({ class: "region" });
          hold = pendingContent(region);
          return Fragment([span({ class: "heading" }, "h"), region]);
        },
        { transition: { enterClass: "in", waitForContent: 2000 } },
      ),
    );
    await flush();
    setOn(true);
    end(q(".heading"));
    end(q(".region"));
    return { hold: () => hold };
  }

  it("a registered node attached and completed in the same task enrolls its content", async () => {
    const { slot, pending } = detachedSlot();
    await open();
    await flush();
    (q(".region") as HTMLElement).append(slot);
    slot.replaceChildren(span({ class: "slot-row" }, "row"));
    pending.done();
    await flush();
    expect(q(".slot-row")?.classList.contains("in")).toBe(true);
  });

  it("a registered node attached while the window is open holds it after the other content settled", async () => {
    const { slot, pending } = detachedSlot();
    const { hold } = await open();
    (q(".region") as HTMLElement).append(slot);
    await flush();
    hold().cancel();
    await flush();
    // The slot is still pending inside the branch: the window stays open.
    expect(entering()).toBe(2);
    slot.replaceChildren(span({ class: "slot-row" }, "row"));
    pending.done();
    await flush();
    expect(q(".slot-row")?.classList.contains("in")).toBe(true);
    end(q(".slot-row"));
    expect(entering()).toBe(0);
  });

  it("removing the last pending node from the branch closes the window at once", async () => {
    const { hold } = await open();
    const { slot } = detachedSlot();
    (q(".region") as HTMLElement).append(slot);
    await flush();
    hold().cancel();
    await flush();
    expect(entering()).toBe(2);
    slot.remove();
    await flush();
    expect(entering()).toBe(0);
  });

  it("content that left the branch before it settled does not join", async () => {
    const { hold } = await open();
    const { slot, pending } = detachedSlot();
    (q(".region") as HTMLElement).append(slot);
    await flush();
    slot.remove();
    slot.replaceChildren(span({ class: "slot-row" }, "row"));
    pending.done();
    await flush();
    expect(slot.querySelector(".slot-row")?.classList.contains("in")).toBe(false);
    hold().cancel();
  });

  it("a closed window does not reopen: a node attached and completed afterwards enters on its own terms", async () => {
    const { hold } = await open();
    hold().cancel();
    await flush();
    expect(entering()).toBe(0);
    const { slot, pending } = detachedSlot();
    (q(".region") as HTMLElement).append(slot);
    slot.replaceChildren(span({ class: "slot-row" }, "row"));
    pending.done();
    await flush();
    expect(q(".slot-row")?.classList.contains("in")).toBe(false);
    expect(pendingCount() - base).toBe(0);
  });
});

describe("custom enter", () => {
  /** `when(on, () => Fragment([heading, inner when(show, slot), region]))`, custom enter. */
  async function open(slot: HTMLElement) {
    let hold!: PendingContent;
    const [on, setOn] = signal(false);
    const [show, setShow] = signal(false);
    const enter = vi.fn();
    host.appendChild(
      when(
        on,
        () => {
          const region = div({ class: "region" });
          hold = pendingContent(region);
          // A sibling range at the branch's top level: the slot is inserted
          // next to the inner anchor, under the same parent as the branch.
          return Fragment([span({ class: "heading" }, "h"), when(show, slot), region]);
        },
        { transition: { enter, waitForContent: 2000 } },
      ),
    );
    await flush();
    setOn(true);
    await flush();
    return { hold: () => hold, setShow, enter };
  }

  it("a pending node removed from a sibling range no longer holds the enter", async () => {
    const { slot } = detachedSlot();
    const { hold, setShow, enter } = await open(slot);
    setShow(true);
    await flush();
    expect(slot.parentNode).toBe(host);
    hold().done();
    await flush();
    // Waiting for the slot, which joined the branch's top level.
    expect(enter).not.toHaveBeenCalled();
    setShow(false);
    await flush();
    expect(slot.parentNode).toBe(null);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a pending node removed from a descendant container no longer holds the enter", async () => {
    const { slot } = detachedSlot();
    const { hold, enter } = await open(div());
    (q(".region") as HTMLElement).append(slot);
    await flush();
    hold().done();
    await flush();
    expect(enter).not.toHaveBeenCalled();
    slot.remove();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(pendingCount() - base).toBe(1);
  });

  it("observation stops when the wait is cancelled by a switch", async () => {
    const { slot } = detachedSlot();
    const [on, setOn] = signal(false);
    const enter = vi.fn();
    host.appendChild(
      when(on, () => Fragment([span({ class: "heading" }, "h"), slot]), {
        transition: { enter, waitForContent: 2000 },
      }),
    );
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    setOn(false);
    await flush();
    // Gone with the branch: the slot was disposed with it (its registration
    // cancelled), and the wait's listeners were dropped.
    expect(pendingCount() - base).toBe(0);
    host.append(div());
    await flush();
    expect(observe).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
  });
});
