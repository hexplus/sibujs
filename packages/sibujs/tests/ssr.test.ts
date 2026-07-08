import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@sibujs/core";
import {
  collectStream,
  deserializeState,
  hydrateIslands,
  hydrateProgressively,
  island,
  renderToDocument,
  renderToReadableStream,
  renderToStream,
  renderToString,
  renderToSuspenseStream,
  resetSSRState,
  serializeState,
  ssrSuspense,
  suspenseSwapScript,
} from "../src/platform/ssr";

describe("renderToString", () => {
  it("should render a simple element to HTML string", () => {
    const el = document.createElement("div");
    el.className = "test";
    el.textContent = "Hello";

    const html = renderToString(el);
    expect(html).toContain("<div");
    expect(html).toContain('class="test"');
    expect(html).toContain("Hello");
    expect(html).toContain("</div>");
  });

  it("should render nested elements", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    child.textContent = "World";
    parent.appendChild(child);

    const html = renderToString(parent);
    expect(html).toContain("<span");
    expect(html).toContain("World");
    expect(html).toContain("</span>");
  });

  it("should handle void elements", () => {
    const el = document.createElement("img");
    el.setAttribute("src", "test.png");

    const html = renderToString(el);
    expect(html).toContain('src="test.png"');
    expect(html).toContain("/>");
    expect(html).not.toContain("</img>");
  });

  it("should escape HTML in text content", () => {
    const el = document.createElement("div");
    el.textContent = "<script>alert('xss')</script>";

    const html = renderToString(el);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("should render DocumentFragment", () => {
    const frag = document.createDocumentFragment();
    const a = document.createElement("span");
    a.textContent = "A";
    const b = document.createElement("span");
    b.textContent = "B";
    frag.appendChild(a);
    frag.appendChild(b);

    const html = renderToString(frag);
    expect(html).toContain("A");
    expect(html).toContain("B");
  });
});

describe("renderToDocument", () => {
  it("should render a full HTML document", () => {
    const html = renderToDocument(
      () => {
        const el = document.createElement("h1");
        el.textContent = "App";
        return el;
      },
      { title: "Test Page" },
    );

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Test Page</title>");
    expect(html).toContain("App");
  });

  it("should include meta tags", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      meta: [{ name: "description", content: "A test page" }],
    });

    expect(html).toContain('name="description"');
    expect(html).toContain('content="A test page"');
  });
});

// ─── renderToStream ─────────────────────────────────────────────────────────

describe("renderToStream", () => {
  it("should yield HTML chunks for a simple element", async () => {
    const el = document.createElement("div");
    el.textContent = "hello";

    const chunks: string[] = [];
    for await (const chunk of renderToStream(el)) {
      chunks.push(chunk);
    }

    // Should produce at least an open tag, the text content, and a close tag
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const combined = chunks.join("");
    expect(combined).toContain("<div");
    expect(combined).toContain("hello");
    expect(combined).toContain("</div>");
  });

  it("should stream nested elements as separate chunks", async () => {
    const parent = document.createElement("section");
    const child = document.createElement("span");
    child.textContent = "inner";
    parent.appendChild(child);

    const chunks: string[] = [];
    for await (const chunk of renderToStream(parent)) {
      chunks.push(chunk);
    }

    // Nested structure produces more chunks than a single element
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    const combined = chunks.join("");
    expect(combined).toContain("<section");
    expect(combined).toContain("<span");
    expect(combined).toContain("inner");
    expect(combined).toContain("</span>");
    expect(combined).toContain("</section>");
  });

  it("should handle void elements without a closing tag", async () => {
    const el = document.createElement("br");

    const chunks: string[] = [];
    for await (const chunk of renderToStream(el)) {
      chunks.push(chunk);
    }

    const combined = chunks.join("");
    expect(combined).toContain("<br");
    expect(combined).toContain("/>");
    expect(combined).not.toContain("</br>");
  });

  it("should handle text nodes", async () => {
    const text = document.createTextNode("just text");

    const chunks: string[] = [];
    for await (const chunk of renderToStream(text)) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("just text");
  });

  it("should escape HTML in text content", async () => {
    const el = document.createElement("p");
    el.textContent = "<script>alert('xss')</script>";

    const combined = await collectStream(renderToStream(el));
    expect(combined).not.toContain("<script>");
    expect(combined).toContain("&lt;script&gt;");
  });

  it("should stream a DocumentFragment by iterating children", async () => {
    const frag = document.createDocumentFragment();
    const a = document.createElement("span");
    a.textContent = "A";
    const b = document.createElement("span");
    b.textContent = "B";
    frag.appendChild(a);
    frag.appendChild(b);

    const combined = await collectStream(renderToStream(frag));
    expect(combined).toContain("<span");
    expect(combined).toContain("A");
    expect(combined).toContain("B");
  });

  it("should include attributes in the streamed output", async () => {
    const el = document.createElement("a");
    el.setAttribute("href", "/page");
    el.setAttribute("class", "link");
    el.textContent = "click";

    const combined = await collectStream(renderToStream(el));
    expect(combined).toContain('href="/page"');
    expect(combined).toContain('class="link"');
  });
});

// ─── collectStream ──────────────────────────────────────────────────────────

describe("collectStream", () => {
  it("should collect stream output into a complete string", async () => {
    const el = document.createElement("div");
    const child = document.createElement("p");
    child.textContent = "content";
    el.appendChild(child);

    const result = await collectStream(renderToStream(el));

    expect(typeof result).toBe("string");
    expect(result).toContain("<div");
    expect(result).toContain("<p");
    expect(result).toContain("content");
    expect(result).toContain("</p>");
    expect(result).toContain("</div>");
  });

  it("should return an empty string for an empty fragment", async () => {
    const frag = document.createDocumentFragment();
    const result = await collectStream(renderToStream(frag));
    expect(result).toBe("");
  });

  it("should work with any async iterable", async () => {
    async function* fakeStream(): AsyncGenerator<string> {
      yield "one";
      yield "two";
      yield "three";
    }
    const result = await collectStream(fakeStream());
    expect(result).toBe("onetwothree");
  });
});

// ─── island ─────────────────────────────────────────────────────────────────

describe("island", () => {
  it("should mark the element with data-sibu-island attribute", () => {
    const component = () => {
      const el = document.createElement("div");
      el.textContent = "island content";
      return el;
    };

    const el = island("counter", component);

    expect(el.getAttribute("data-sibu-island")).toBe("counter");
    expect(el.textContent).toBe("island content");
  });

  it("should preserve existing attributes on the element", () => {
    const component = () => {
      const el = document.createElement("section");
      el.setAttribute("class", "widget");
      el.setAttribute("id", "my-island");
      return el;
    };

    const el = island("widget-1", component);

    expect(el.getAttribute("data-sibu-island")).toBe("widget-1");
    expect(el.getAttribute("class")).toBe("widget");
    expect(el.getAttribute("id")).toBe("my-island");
  });

  it("should return an HTMLElement", () => {
    const el = island("test", () => document.createElement("div"));
    expect(el).toBeInstanceOf(HTMLElement);
  });
});

// ─── hydrateIslands ─────────────────────────────────────────────────────────

describe("hydrateIslands", () => {
  it("should selectively hydrate only island-marked elements", () => {
    const container = document.createElement("div");

    // Simulate server-rendered HTML with an island and static sections
    container.innerHTML = `
      <header>Static Header</header>
      <div data-sibu-island="counter"><span>0</span></div>
      <footer>Static Footer</footer>
    `;

    const counterFactory = () => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "0";
      el.appendChild(span);
      return el;
    };

    hydrateIslands(container, { counter: counterFactory });

    // The island element should be marked as hydrated
    const islandEl = container.querySelector('[data-sibu-island="counter"]');
    expect(islandEl?.getAttribute("data-sibu-hydrated")).toBe("true");

    // The container should be marked with partial hydration
    expect(container.getAttribute("data-sibu-hydrated")).toBe("partial");

    // Static content should remain untouched
    expect(container.querySelector("header")?.textContent).toBe("Static Header");
    expect(container.querySelector("footer")?.textContent).toBe("Static Footer");
  });

  it("should skip islands with no matching factory", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div data-sibu-island="missing"><span>content</span></div>
    `;

    // Provide an empty map; no factories match
    hydrateIslands(container, {});

    const islandEl = container.querySelector('[data-sibu-island="missing"]');
    // Should NOT be marked as hydrated since no factory matched
    expect(islandEl?.hasAttribute("data-sibu-hydrated")).toBe(false);

    // Container should still be marked as partially hydrated
    expect(container.getAttribute("data-sibu-hydrated")).toBe("partial");
  });

  it("should hydrate multiple islands independently", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div data-sibu-island="alpha"><span>A</span></div>
      <div data-sibu-island="beta"><span>B</span></div>
    `;

    const alphaFactory = () => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "A";
      el.appendChild(span);
      return el;
    };
    const betaFactory = () => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "B";
      el.appendChild(span);
      return el;
    };

    hydrateIslands(container, { alpha: alphaFactory, beta: betaFactory });

    const alpha = container.querySelector('[data-sibu-island="alpha"]');
    const beta = container.querySelector('[data-sibu-island="beta"]');
    expect(alpha?.getAttribute("data-sibu-hydrated")).toBe("true");
    expect(beta?.getAttribute("data-sibu-hydrated")).toBe("true");
  });
});

// ─── serializeState ─────────────────────────────────────────────────────────

describe("serializeState", () => {
  it("should serialize state to a script tag", () => {
    const result = serializeState({ count: 42, name: "test" });

    expect(result).toContain("<script>");
    expect(result).toContain("</script>");
    expect(result).toContain("window.__SIBU_SSR_DATA__=");
    expect(result).toContain('"count":42');
    expect(result).toContain('"name":"test"');
  });

  it("should apply XSS-safe escaping for angle brackets", () => {
    const result = serializeState({ payload: "<img onerror=alert(1)>" });

    // The raw < and > must be escaped to unicode
    expect(result).not.toContain("<img");
    expect(result).toContain("\\u003c");
    expect(result).toContain("\\u003e");
  });

  it("should escape ampersands", () => {
    const result = serializeState({ query: "a&b" });

    expect(result).toContain("\\u0026");
    expect(result).not.toMatch(/"a&b"/);
  });

  it("should handle empty state", () => {
    const result = serializeState({});

    expect(result).toBe("<script>window.__SIBU_SSR_DATA__={}</script>");
  });

  it("should handle nested objects", () => {
    const result = serializeState({ user: { id: 1, roles: ["admin"] } });

    expect(result).toContain("window.__SIBU_SSR_DATA__=");
    expect(result).toContain('"user"');
    expect(result).toContain('"roles"');
  });
});

// ─── deserializeState ───────────────────────────────────────────────────────

describe("deserializeState", () => {
  beforeEach(() => {
    // Clean up any prior state on window
    delete (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__;
  });

  it("should return undefined when no state has been set", () => {
    const state = deserializeState();
    expect(state).toBeUndefined();
  });

  it("should retrieve state from window when set", () => {
    (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__ = { count: 10, active: true };

    const state = deserializeState<{ count: number; active: boolean }>();
    expect(state).toEqual({ count: 10, active: true });
  });

  it("should return the correct type", () => {
    (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__ = { items: [1, 2, 3] };

    const state = deserializeState<{ items: number[] }>();
    expect(state?.items).toEqual([1, 2, 3]);
  });
});

// ─── mount (enhanced) ───────────────────────────────────────────────────────

describe("mount", () => {
  it("should accept a function component and append its result", () => {
    const container = document.createElement("div");
    const component = () => {
      const el = document.createElement("p");
      el.textContent = "from function";
      return el;
    };

    const { node } = mount(component, container);

    expect(container.children.length).toBe(1);
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("p");
    expect(container.textContent).toBe("from function");
    expect(node).toBe(container.firstElementChild);
  });

  it("should accept a direct HTMLElement", () => {
    const container = document.createElement("div");
    const el = document.createElement("span");
    el.textContent = "direct element";

    const { node } = mount(el, container);

    expect(container.children.length).toBe(1);
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("span");
    expect(container.textContent).toBe("direct element");
    expect(node).toBe(el);
  });

  it("should accept a Node (e.g., text node)", () => {
    const container = document.createElement("div");
    const textNode = document.createTextNode("plain text");

    const { node } = mount(textNode, container);

    expect(container.childNodes.length).toBe(1);
    expect(container.textContent).toBe("plain text");
    expect(node).toBe(textNode);
  });

  it("should throw if the container is null", () => {
    const el = document.createElement("div");

    expect(() => mount(el, null)).toThrow("container element not found");
  });

  it("should return the mounted node and unmount function", () => {
    const container = document.createElement("div");
    const el = document.createElement("article");

    const { node, unmount } = mount(el, container);
    expect(node).toBe(el);
    expect(typeof unmount).toBe("function");
  });
});

// ============================================================================
// renderToReadableStream
// ============================================================================

describe("renderToReadableStream", () => {
  async function readAll(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let result = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      result += value;
    }
    return result;
  }

  it("should return a ReadableStream instance", () => {
    const el = document.createElement("div");
    el.textContent = "hello";
    const stream = renderToReadableStream(el);
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it("should produce HTML matching renderToString structure", async () => {
    const el = document.createElement("div");
    const child = document.createElement("span");
    child.textContent = "content";
    el.appendChild(child);

    const result = await readAll(renderToReadableStream(el));
    expect(result).toContain("<div");
    expect(result).toContain("<span");
    expect(result).toContain("content");
    expect(result).toContain("</span>");
    expect(result).toContain("</div>");
  });

  it("should handle text nodes", async () => {
    const text = document.createTextNode("plain text");
    const result = await readAll(renderToReadableStream(text));
    expect(result).toBe("plain text");
  });

  it("should handle void elements", async () => {
    const el = document.createElement("br");
    const result = await readAll(renderToReadableStream(el));
    expect(result).toContain("<br");
    expect(result).toContain("/>");
  });

  it("should handle cancel gracefully", async () => {
    const el = document.createElement("div");
    const stream = renderToReadableStream(el);
    await stream.cancel();
    // Should not throw
  });

  it("should handle DocumentFragment", async () => {
    const frag = document.createDocumentFragment();
    const p = document.createElement("p");
    p.textContent = "one";
    const span = document.createElement("span");
    span.textContent = "two";
    frag.appendChild(p);
    frag.appendChild(span);

    const result = await readAll(renderToReadableStream(frag));
    expect(result).toContain("<p");
    expect(result).toContain("one");
    expect(result).toContain("<span");
    expect(result).toContain("two");
  });
});

// ============================================================================
// hydrateProgressively
// ============================================================================

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  elements: Element[] = [];
  static instances: MockIntersectionObserver[] = [];

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.elements.push(element);
  }
  unobserve(element: Element) {
    this.elements = this.elements.filter((e) => e !== element);
  }
  disconnect() {
    this.elements = [];
  }
  trigger(entries: Partial<IntersectionObserverEntry>[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

describe("hydrateProgressively", () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  });

  it("should not hydrate islands until they intersect", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-sibu-island="counter"><span>0</span></div>';

    const factory = vi.fn(() => {
      const el = document.createElement("div");
      el.appendChild(document.createElement("span"));
      return el;
    });

    hydrateProgressively(container, { counter: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(container.getAttribute("data-sibu-hydrated")).toBe("progressive");
  });

  it("should hydrate an island when it becomes visible", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-sibu-island="widget"><span>W</span></div>';

    const factory = () => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "W";
      el.appendChild(span);
      return el;
    };

    hydrateProgressively(container, { widget: factory });
    const observer = MockIntersectionObserver.instances[0];
    observer.trigger([{ isIntersecting: true }]);

    const islandEl = container.querySelector('[data-sibu-island="widget"]');
    expect(islandEl?.getAttribute("data-sibu-hydrated")).toBe("true");
  });

  it("should not hydrate when not intersecting", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-sibu-island="a"><span>A</span></div>';

    const factory = vi.fn(() => document.createElement("div"));
    hydrateProgressively(container, { a: factory });

    const observer = MockIntersectionObserver.instances[0];
    observer.trigger([{ isIntersecting: false }]);

    expect(factory).not.toHaveBeenCalled();
  });

  it("should return a cleanup function that disconnects observers", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-sibu-island="a"><span>A</span></div>';

    const cleanup = hydrateProgressively(container, {
      a: () => document.createElement("div"),
    });

    expect(MockIntersectionObserver.instances.length).toBe(1);
    expect(MockIntersectionObserver.instances[0].elements.length).toBe(1);

    cleanup();
    expect(MockIntersectionObserver.instances[0].elements.length).toBe(0);
  });

  it("should skip islands without matching factory", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-sibu-island="unknown"><span>?</span></div>';

    const cleanup = hydrateProgressively(container, {});
    // No observers created for unmatched islands
    expect(MockIntersectionObserver.instances.length).toBe(0);
    cleanup();
  });
});

// ============================================================================
// ssrSuspense
// ============================================================================

describe("ssrSuspense", () => {
  beforeEach(() => {
    resetSSRState();
  });

  it("should render fallback element with suspense ID attribute", () => {
    const { element } = ssrSuspense({
      fallback: () => {
        const el = document.createElement("div");
        el.textContent = "Loading...";
        return el;
      },
      content: () => Promise.resolve(document.createElement("div")),
    });
    expect(element.getAttribute("data-sibu-suspense-id")).toMatch(/^sibu-sus-\d+$/);
    expect(element.textContent).toBe("Loading...");
  });

  it("should return a promise that resolves to content HTML", async () => {
    const { promise } = ssrSuspense({
      fallback: () => document.createElement("div"),
      content: async () => {
        const el = document.createElement("p");
        el.textContent = "Resolved!";
        return el;
      },
    });
    const result = await promise;
    expect(result.html).toContain("Resolved!");
    expect(result.id).toMatch(/^sibu-sus-\d+$/);
  });

  it("should generate sequential IDs", () => {
    const { element: el1 } = ssrSuspense({
      fallback: () => document.createElement("div"),
      content: () => Promise.resolve(document.createElement("div")),
    });
    const { element: el2 } = ssrSuspense({
      fallback: () => document.createElement("div"),
      content: () => Promise.resolve(document.createElement("div")),
    });
    expect(el1.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-0");
    expect(el2.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-1");
  });

  it("should reset IDs with resetSSRState", () => {
    ssrSuspense({
      fallback: () => document.createElement("div"),
      content: () => Promise.resolve(document.createElement("div")),
    });
    resetSSRState();
    const { element } = ssrSuspense({
      fallback: () => document.createElement("div"),
      content: () => Promise.resolve(document.createElement("div")),
    });
    expect(element.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-0");
  });
});

// ============================================================================
// suspenseSwapScript
// ============================================================================

describe("suspenseSwapScript", () => {
  it("should generate a self-executing script", () => {
    const script = suspenseSwapScript("sibu-sus-0");
    expect(script).toContain("<script>");
    expect(script).toContain("sibu-resolved-sibu-sus-0");
    expect(script).toContain("</script>");
  });

  it("should reference both the resolved content and fallback element", () => {
    const script = suspenseSwapScript("sibu-sus-5");
    expect(script).toContain("sibu-resolved-sibu-sus-5");
    expect(script).toContain('data-sibu-suspense-id="sibu-sus-5"');
  });
});

// ============================================================================
// renderToSuspenseStream
// ============================================================================

describe("renderToSuspenseStream", () => {
  beforeEach(() => {
    resetSSRState();
  });

  it("should yield main content without pending boundaries", async () => {
    const el = document.createElement("div");
    el.textContent = "Hello";

    const chunks: string[] = [];
    for await (const chunk of renderToSuspenseStream(el)) {
      chunks.push(chunk);
    }
    const combined = chunks.join("");
    expect(combined).toContain("Hello");
    expect(combined).not.toContain("<script>");
  });

  it("should yield fallback then resolved content with swap script", async () => {
    const fallback = document.createElement("div");
    fallback.textContent = "Loading...";
    fallback.setAttribute("data-sibu-suspense-id", "sibu-sus-0");

    const pending = [Promise.resolve({ id: "sibu-sus-0", html: "<p>Done</p>" })];

    const chunks: string[] = [];
    for await (const chunk of renderToSuspenseStream(fallback, pending)) {
      chunks.push(chunk);
    }
    const combined = chunks.join("");

    expect(combined).toContain("Loading...");
    expect(combined).toContain('<div hidden id="sibu-resolved-sibu-sus-0">');
    expect(combined).toContain("<p>Done</p>");
    expect(combined).toContain("<script>");
  });

  it("should handle multiple pending boundaries", async () => {
    const el = document.createElement("div");

    const pending = [Promise.resolve({ id: "a", html: "<p>A</p>" }), Promise.resolve({ id: "b", html: "<p>B</p>" })];

    const chunks: string[] = [];
    for await (const chunk of renderToSuspenseStream(el, pending)) {
      chunks.push(chunk);
    }
    const combined = chunks.join("");

    expect(combined).toContain("sibu-resolved-a");
    expect(combined).toContain("sibu-resolved-b");
    expect(combined).toContain("<p>A</p>");
    expect(combined).toContain("<p>B</p>");
  });

  it("should integrate with ssrSuspense", async () => {
    const { element, promise } = ssrSuspense({
      fallback: () => {
        const el = document.createElement("span");
        el.textContent = "Wait...";
        return el;
      },
      content: async () => {
        const el = document.createElement("div");
        el.textContent = "Ready!";
        return el;
      },
    });

    const chunks: string[] = [];
    for await (const chunk of renderToSuspenseStream(element, [promise])) {
      chunks.push(chunk);
    }
    const combined = chunks.join("");

    expect(combined).toContain("Wait...");
    expect(combined).toContain("Ready!");
    expect(combined).toContain("<script>");
  });
});
