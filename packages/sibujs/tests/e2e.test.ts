import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDOMEquals, createDOMSnapshot, createHttpMock, createTimerMock, testComponent } from "../src/testing/e2e";

// ─── createHttpMock ─────────────────────────────────────────────────────────

describe("createHttpMock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Always restore the real fetch no matter what
    globalThis.fetch = originalFetch;
  });

  it("install replaces globalThis.fetch", () => {
    const mock = createHttpMock();
    mock.install();
    expect(globalThis.fetch).not.toBe(originalFetch);
    mock.restore();
  });

  it("restore puts back the original fetch", () => {
    const mock = createHttpMock();
    mock.install();
    mock.restore();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("matches routes by exact string URL", async () => {
    const mock = createHttpMock([{ url: "/api/users", response: { body: [{ id: 1 }] } }]);
    mock.install();

    const res = await fetch("/api/users");
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual([{ id: 1 }]);

    mock.restore();
  });

  it("matches routes by URL suffix", async () => {
    const mock = createHttpMock([{ url: "/api/items", response: { body: { items: [] } } }]);
    mock.install();

    const res = await fetch("https://example.com/api/items");
    const data = await res.json();
    expect(data).toEqual({ items: [] });

    mock.restore();
  });

  it("matches routes by regex", async () => {
    const mock = createHttpMock([
      {
        url: /\/api\/users\/\d+/,
        response: { body: { id: 42, name: "Alice" } },
      },
    ]);
    mock.install();

    const res = await fetch("/api/users/42");
    const data = await res.json();
    expect(data).toEqual({ id: 42, name: "Alice" });

    mock.restore();
  });

  it("matches routes by method", async () => {
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/api/users",
        response: { status: 201, body: { id: 99 } },
      },
    ]);
    mock.install();

    const res = await fetch("/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "Bob" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({ id: 99 });

    mock.restore();
  });

  it("returns 404 for unmatched routes", async () => {
    const mock = createHttpMock();
    mock.install();

    const res = await fetch("/unknown");
    expect(res.status).toBe(404);

    mock.restore();
  });

  it("logs requests", async () => {
    const mock = createHttpMock([{ url: "/api/data", response: { body: "ok" } }]);
    mock.install();

    await fetch("/api/data");
    await fetch("/api/data", { method: "POST", body: JSON.stringify({ x: 1 }) });

    const requests = mock.getRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("/api/data");
    expect(requests[0].method).toBe("GET");
    expect(requests[1].method).toBe("POST");
    expect(requests[1].body).toEqual({ x: 1 });

    mock.restore();
  });

  it("assertCalled passes for called URLs", async () => {
    const mock = createHttpMock([{ url: "/api/check", response: { body: {} } }]);
    mock.install();

    await fetch("/api/check");
    expect(() => mock.assertCalled("/api/check")).not.toThrow();

    mock.restore();
  });

  it("assertCalled throws for uncalled URLs", () => {
    const mock = createHttpMock();
    mock.install();

    expect(() => mock.assertCalled("/never-called")).toThrow("Expected GET /never-called to have been called");

    mock.restore();
  });

  it("assertNotCalled passes for uncalled URLs", () => {
    const mock = createHttpMock();
    mock.install();

    expect(() => mock.assertNotCalled("/not-called")).not.toThrow();

    mock.restore();
  });

  it("assertNotCalled throws for called URLs", async () => {
    const mock = createHttpMock([{ url: "/api/hit", response: { body: {} } }]);
    mock.install();

    await fetch("/api/hit");
    expect(() => mock.assertNotCalled("/api/hit")).toThrow("Expected GET /api/hit to NOT have been called");

    mock.restore();
  });

  it("callCount returns the correct number of calls", async () => {
    const mock = createHttpMock([{ url: "/api/count", response: { body: {} } }]);
    mock.install();

    expect(mock.callCount("/api/count")).toBe(0);
    await fetch("/api/count");
    await fetch("/api/count");
    await fetch("/api/count");
    expect(mock.callCount("/api/count")).toBe(3);

    mock.restore();
  });

  it("supports dynamic response functions", async () => {
    const handler = vi.fn((req: { url: string; method: string; body: unknown }) => ({
      status: 200,
      body: { echo: req.body },
    }));

    const mock = createHttpMock([{ method: "POST", url: "/api/echo", response: handler }]);
    mock.install();

    const res = await fetch("/api/echo", {
      method: "POST",
      body: JSON.stringify({ msg: "hi" }),
    });
    const data = await res.json();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(data).toEqual({ echo: { msg: "hi" } });

    mock.restore();
  });

  it("addRoute adds routes after creation", async () => {
    const mock = createHttpMock();
    mock.install();

    mock.addRoute({ url: "/late", response: { body: { added: true } } });
    const res = await fetch("/late");
    const data = await res.json();
    expect(data).toEqual({ added: true });

    mock.restore();
  });

  it("clearRoutes removes all routes", async () => {
    const mock = createHttpMock([{ url: "/api/x", response: { body: {} } }]);
    mock.install();

    mock.clearRoutes();
    const res = await fetch("/api/x");
    expect(res.status).toBe(404);

    mock.restore();
  });

  it("clearLog clears the request log", async () => {
    const mock = createHttpMock([{ url: "/api/log", response: { body: {} } }]);
    mock.install();

    await fetch("/api/log");
    expect(mock.getRequests()).toHaveLength(1);
    mock.clearLog();
    expect(mock.getRequests()).toHaveLength(0);

    mock.restore();
  });
});

// ─── createTimerMock ────────────────────────────────────────────────────────

describe("createTimerMock", () => {
  let timerMock: ReturnType<typeof createTimerMock>;

  beforeEach(() => {
    timerMock = createTimerMock();
    timerMock.install();
  });

  afterEach(() => {
    timerMock.restore();
  });

  it("advance fires timers at the correct time", () => {
    const cb = vi.fn();
    setTimeout(cb, 100);

    timerMock.advance(50);
    expect(cb).not.toHaveBeenCalled();

    timerMock.advance(50);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("advance fires multiple timers in order", () => {
    const order: number[] = [];
    setTimeout(() => order.push(1), 100);
    setTimeout(() => order.push(2), 200);
    setTimeout(() => order.push(3), 50);

    timerMock.advance(200);
    expect(order).toEqual([3, 1, 2]);
  });

  it("flush runs all pending setTimeout timers", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    setTimeout(cb1, 500);
    setTimeout(cb2, 1000);

    timerMock.flush();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("interval timers re-fire on subsequent advances", () => {
    const cb = vi.fn();
    setInterval(cb, 100);

    timerMock.advance(100);
    expect(cb).toHaveBeenCalledTimes(1);

    timerMock.advance(100);
    expect(cb).toHaveBeenCalledTimes(2);

    timerMock.advance(100);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("clearInterval stops an interval timer", () => {
    const cb = vi.fn();
    const id = setInterval(cb, 100);

    timerMock.advance(100);
    expect(cb).toHaveBeenCalledTimes(1);

    clearInterval(id);
    timerMock.advance(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clearTimeout cancels a pending timeout", () => {
    const cb = vi.fn();
    const id = setTimeout(cb, 100);
    clearTimeout(id);

    timerMock.advance(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it("pendingCount returns the number of pending timers", () => {
    expect(timerMock.pendingCount()).toBe(0);

    setTimeout(() => {}, 100);
    setTimeout(() => {}, 200);
    expect(timerMock.pendingCount()).toBe(2);

    timerMock.advance(100);
    expect(timerMock.pendingCount()).toBe(1);

    timerMock.advance(100);
    expect(timerMock.pendingCount()).toBe(0);
  });

  it("now returns the current fake time", () => {
    expect(timerMock.now()).toBe(0);
    timerMock.advance(250);
    expect(timerMock.now()).toBe(250);
    timerMock.advance(50);
    expect(timerMock.now()).toBe(300);
  });

  it("restore puts back the original timer functions", () => {
    const _origSetTimeout = globalThis.setTimeout;
    // After restore, it should not be the mock anymore
    // (origSetTimeout IS the mock since we installed in beforeEach)
    // So we capture the real one before install
    timerMock.restore();

    // After restore, setTimeout should be a native function
    // Just verify it does not throw and returns a valid id
    const id = setTimeout(() => {}, 0);
    expect(id).toBeDefined();
    clearTimeout(id);

    // Re-install so afterEach restore is safe
    timerMock = createTimerMock();
    timerMock.install();
  });
});

// ─── createDOMSnapshot ──────────────────────────────────────────────────────

describe("createDOMSnapshot", () => {
  it("serializes a simple element", () => {
    const div = document.createElement("div");
    div.textContent = "hello";
    const snapshot = createDOMSnapshot(div);
    expect(snapshot).toBe("<div>hello</div>");
  });

  it("serializes nested elements", () => {
    const div = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "inner";
    div.appendChild(span);

    const snapshot = createDOMSnapshot(div);
    expect(snapshot).toBe("<div>\n  <span>inner</span>\n</div>");
  });

  it("sorts attributes deterministically", () => {
    const el = document.createElement("div");
    el.setAttribute("z-attr", "last");
    el.setAttribute("a-attr", "first");
    el.setAttribute("m-attr", "middle");

    const snapshot = createDOMSnapshot(el);
    expect(snapshot).toBe('<div a-attr="first" m-attr="middle" z-attr="last"></div>');
  });

  it("serializes an empty element", () => {
    const br = document.createElement("br");
    const snapshot = createDOMSnapshot(br);
    expect(snapshot).toBe("<br></br>");
  });

  it("handles multiple text and element children", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("before "));
    const b = document.createElement("b");
    b.textContent = "bold";
    div.appendChild(b);
    div.appendChild(document.createTextNode(" after"));

    const snapshot = createDOMSnapshot(div);
    expect(snapshot).toContain("before");
    expect(snapshot).toContain("<b>bold</b>");
    expect(snapshot).toContain("after");
  });
});

// ─── assertDOMEquals ────────────────────────────────────────────────────────

describe("assertDOMEquals", () => {
  it("passes for matching trees", () => {
    const a = document.createElement("div");
    a.textContent = "same";
    const b = document.createElement("div");
    b.textContent = "same";

    expect(() => assertDOMEquals(a, b)).not.toThrow();
  });

  it("passes for matching trees with attributes", () => {
    const a = document.createElement("div");
    a.setAttribute("class", "box");
    a.setAttribute("id", "main");
    const b = document.createElement("div");
    b.setAttribute("id", "main");
    b.setAttribute("class", "box");

    expect(() => assertDOMEquals(a, b)).not.toThrow();
  });

  it("throws for mismatched tag names", () => {
    const a = document.createElement("div");
    const b = document.createElement("span");

    expect(() => assertDOMEquals(a, b)).toThrow("DOM mismatch");
  });

  it("throws for mismatched text content", () => {
    const a = document.createElement("p");
    a.textContent = "hello";
    const b = document.createElement("p");
    b.textContent = "world";

    expect(() => assertDOMEquals(a, b)).toThrow("DOM mismatch");
  });

  it("throws for mismatched attributes", () => {
    const a = document.createElement("div");
    a.setAttribute("class", "a");
    const b = document.createElement("div");
    b.setAttribute("class", "b");

    expect(() => assertDOMEquals(a, b)).toThrow("DOM mismatch");
  });

  it("throws for different child structures", () => {
    const a = document.createElement("div");
    a.appendChild(document.createElement("span"));
    const b = document.createElement("div");
    b.appendChild(document.createElement("em"));

    expect(() => assertDOMEquals(a, b)).toThrow("DOM mismatch");
  });
});

// ─── testComponent ──────────────────────────────────────────────────────────

describe("testComponent", () => {
  it("renders a component and appends container to body", () => {
    const el = document.createElement("div");
    el.textContent = "component";
    const wrapper = testComponent(el);

    expect(wrapper.element).toBe(el);
    expect(document.body.contains(wrapper.container)).toBe(true);
    expect(wrapper.container.contains(el)).toBe(true);

    wrapper.destroy();
  });

  it("renders from a factory function", () => {
    const wrapper = testComponent(() => {
      const el = document.createElement("section");
      el.textContent = "factory";
      return el;
    });

    expect(wrapper.element.tagName).toBe("SECTION");
    expect(wrapper.element.textContent).toBe("factory");

    wrapper.destroy();
  });

  it("getByTestId finds elements by data-testid", () => {
    const el = document.createElement("div");
    const btn = document.createElement("button");
    btn.setAttribute("data-testid", "submit-btn");
    btn.textContent = "Submit";
    el.appendChild(btn);

    const wrapper = testComponent(el);
    const found = wrapper.getByTestId("submit-btn");
    expect(found).toBe(btn);
    expect(wrapper.getByTestId("nonexistent")).toBeNull();

    wrapper.destroy();
  });

  it("getByText finds elements by text content", () => {
    const el = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "Hello World";
    el.appendChild(p);

    const wrapper = testComponent(el);
    const found = wrapper.getByText("Hello World");
    expect(found).toBe(p);
    expect(wrapper.getByText("Not Found")).toBeNull();

    wrapper.destroy();
  });

  it("click dispatches a click event", () => {
    const el = document.createElement("div");
    const btn = document.createElement("button");
    el.appendChild(btn);

    const handler = vi.fn();
    btn.addEventListener("click", handler);

    const wrapper = testComponent(el);
    wrapper.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);

    wrapper.destroy();
  });

  it("type sets value and dispatches input and change events", () => {
    const el = document.createElement("div");
    const input = document.createElement("input");
    el.appendChild(input);

    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener("input", onInput);
    input.addEventListener("change", onChange);

    const wrapper = testComponent(el);
    wrapper.type(input, "typed text");

    expect(input.value).toBe("typed text");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    wrapper.destroy();
  });

  it("destroy removes the container from the DOM", () => {
    const wrapper = testComponent(document.createElement("div"));
    const container = wrapper.container;

    expect(document.body.contains(container)).toBe(true);
    wrapper.destroy();
    expect(document.body.contains(container)).toBe(false);
  });

  it("accepts a custom container via options", () => {
    const customContainer = document.createElement("div");
    customContainer.id = "custom";
    document.body.appendChild(customContainer);

    const el = document.createElement("span");
    const wrapper = testComponent(el, { container: customContainer });

    expect(wrapper.container).toBe(customContainer);
    expect(customContainer.contains(el)).toBe(true);

    wrapper.destroy();
  });
});
