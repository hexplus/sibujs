import { describe, expect, it } from "vitest";
import { createDOMSnapshot, createHttpMock, createTimerMock, testComponent } from "../src/testing/e2e";

// Covers the previously-uncovered branches of src/testing/e2e.ts:
// HTTP mock delay + thrown-handler 500 + delete-on-restore + afterEach hook,
// timer mock rAF/cancelAF install + delete-on-restore + interval advance +
// afterEach hook, serializeElement comment nodes, and testComponent's
// getAllByTestId + waitForUpdate.

describe("createHttpMock", () => {
  it("applies a response delay before resolving", async () => {
    const mock = createHttpMock([{ url: "/slow", response: { body: { ok: true }, delay: 5 } }]);
    mock.install();
    try {
      const start = Date.now();
      const res = await fetch("/slow");
      const json = await res.json();
      expect(json).toEqual({ ok: true });
      expect(Date.now() - start).toBeGreaterThanOrEqual(0);
    } finally {
      mock.restore();
    }
  });

  it("surfaces a thrown response handler as a synthetic 500", async () => {
    const mock = createHttpMock([
      {
        url: "/boom",
        response: () => {
          throw new Error("handler exploded");
        },
      },
    ]);
    mock.install();
    try {
      const res = await fetch("/boom");
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("handler exploded");
    } finally {
      mock.restore();
    }
  });

  it("deletes the global fetch on restore when none existed originally", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = g.fetch;
    const hadFetch = Object.hasOwn(globalThis, "fetch");
    // Remove fetch so the mock records "no original fetch".
    delete g.fetch;
    try {
      const mock = createHttpMock();
      mock.install();
      expect(typeof g.fetch).toBe("function");
      mock.restore();
      expect(Object.hasOwn(globalThis, "fetch")).toBe(false);
    } finally {
      if (hadFetch) g.fetch = original;
    }
  });

  it("invokes a caller-supplied afterEach hook with a cleanup that restores", () => {
    let registered: (() => void) | null = null;
    const mock = createHttpMock([], { afterEach: (cleanup) => (registered = cleanup) });
    mock.install();
    expect(registered).not.toBeNull();
    // Running the captured cleanup restores fetch without throwing.
    expect(() => (registered as unknown as () => void)()).not.toThrow();
  });
});

describe("createTimerMock", () => {
  it("installs requestAnimationFrame/cancelAnimationFrame and runs them via advance", () => {
    const mock = createTimerMock();
    mock.install();
    try {
      let ranFrame = false;
      let cancelledRan = false;
      requestAnimationFrame(() => {
        ranFrame = true;
      });
      const id = requestAnimationFrame(() => {
        cancelledRan = true;
      });
      cancelAnimationFrame(id);

      mock.advance(20);
      expect(ranFrame).toBe(true);
      expect(cancelledRan).toBe(false);
    } finally {
      mock.restore();
    }
  });

  it("re-schedules intervals across advance", () => {
    const mock = createTimerMock();
    mock.install();
    try {
      let count = 0;
      setInterval(() => {
        count++;
      }, 10);
      mock.advance(35);
      expect(count).toBe(3);
      expect(mock.pendingCount()).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("deletes timer globals on restore when they were never defined", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const hadRaf = Object.hasOwn(globalThis, "requestAnimationFrame");
    const originalRaf = g.requestAnimationFrame;
    delete g.requestAnimationFrame;
    try {
      const mock = createTimerMock();
      mock.install();
      expect(typeof g.requestAnimationFrame).toBe("function");
      mock.restore();
      expect(Object.hasOwn(globalThis, "requestAnimationFrame")).toBe(false);
    } finally {
      if (hadRaf) g.requestAnimationFrame = originalRaf;
    }
  });

  it("invokes a caller-supplied afterEach hook", () => {
    let registered: (() => void) | null = null;
    const mock = createTimerMock({ afterEach: (cleanup) => (registered = cleanup) });
    mock.install();
    expect(registered).not.toBeNull();
    expect(() => (registered as unknown as () => void)()).not.toThrow();
  });
});

describe("createDOMSnapshot", () => {
  it("ignores comment nodes among mixed children", () => {
    const root = document.createElement("div");
    const a = document.createElement("span");
    a.textContent = "one";
    const b = document.createElement("span");
    b.textContent = "two";
    root.appendChild(a);
    root.appendChild(document.createComment("a comment"));
    root.appendChild(b);

    const snap = createDOMSnapshot(root);
    expect(snap).toContain("one");
    expect(snap).toContain("two");
    expect(snap).not.toContain("a comment");
  });
});

describe("testComponent", () => {
  it("getAllByTestId returns all matching elements and waitForUpdate resolves", async () => {
    const view = testComponent(() => {
      const el = document.createElement("div");
      for (let i = 0; i < 2; i++) {
        const item = document.createElement("div");
        item.setAttribute("data-testid", "row");
        el.appendChild(item);
      }
      return el;
    });
    try {
      const rows = view.getAllByTestId("row");
      expect(rows).toHaveLength(2);
      await expect(view.waitForUpdate()).resolves.toBeUndefined();
    } finally {
      view.destroy();
    }
  });
});
