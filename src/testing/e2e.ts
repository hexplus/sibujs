/**
 * E2E testing utilities and mocks for SibuJS.
 * Provides DOM fakes, HTTP mocks, and testing helpers for CI/CD integration.
 */

import { reportError } from "../core/errors";
import { replaceChildrenSafely } from "../core/rendering/dispose";
import { queryAllByAttribute, queryByAttribute } from "./queries";
import { serializeDom } from "./serializeDom";

// ─── HTTP Mock ──────────────────────────────────────────────────────────────

export interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Delay before responding in ms */
  delay?: number;
}

export interface MockRoute {
  method?: string; // default: GET
  url: string | RegExp;
  response:
    | MockResponse
    | ((req: { url: string; method: string; body: unknown; headers: Headers }) => MockResponse | Promise<MockResponse>);
}

/**
 * Create an HTTP mock server that intercepts fetch calls.
 * Useful for testing components that make API calls.
 */
export function createHttpMock(routes: MockRoute[] = [], options: { afterEach?: (cleanup: () => void) => void } = {}) {
  const originalFetch = globalThis.fetch;
  const hadOriginalFetch = Object.hasOwn(globalThis, "fetch");
  const requestLog: Array<{ url: string; method: string; body: unknown; timestamp: number }> = [];
  const mockRoutes = [...routes];

  // String routes match exactly — `url.endsWith(route)` let "/api/users" match
  // "https://x/evil/api/users". An absolute route is compared to the full URL
  // (without its fragment); a path route to the request's pathname, plus its
  // query when the route itself contains one. RegExp routes see the full URL.
  function matchesStringRoute(route: string, url: string): boolean {
    if (url === route) return true;
    let target: URL;
    try {
      target = new URL(url, "http://localhost");
    } catch {
      return false;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(route)) {
      return `${target.origin}${target.pathname}${target.search}` === route || target.href === route;
    }
    const hashIndex = route.indexOf("#");
    const bare = hashIndex === -1 ? route : route.slice(0, hashIndex);
    return bare.includes("?") ? `${target.pathname}${target.search}` === bare : target.pathname === bare;
  }

  function matchRoute(url: string, method: string): MockRoute | undefined {
    return mockRoutes.find((route) => {
      const methodMatch = !route.method || route.method.toUpperCase() === method.toUpperCase();
      if (!methodMatch) return false;
      if (typeof route.url === "string") return matchesStringRoute(route.url, url);
      route.url.lastIndex = 0;
      return route.url.test(url);
    });
  }

  // Like fetch(), reject with the signal's reason — a TimeoutError from
  // AbortSignal.timeout() or a custom reason passed to abort() — and fall back
  // to an AbortError only when no reason is available.
  const abortError = (signal: AbortSignal): unknown =>
    signal.reason !== undefined ? signal.reason : new DOMException("The operation was aborted.", "AbortError");

  // ── Request normalization ──
  // Every call is turned into ONE effective Request, exactly as fetch() would
  // build it: a Request input is cloned (so the caller's stays unconsumed) and
  // `init` overrides its method, headers and body. Method, headers and body are
  // then all read from that request, so the handler's `headers` — including the
  // Content-Type fetch generates for FormData, URLSearchParams and typed Blobs —
  // always describe the body it receives. The body is decoded by that type:
  //   multipart/form-data               → FormData
  //   application/x-www-form-urlencoded → URLSearchParams
  //   text-like (text/*, JSON, XML)     → parsed JSON, else the string
  //   anything else (binary, untyped)   → Blob
  const isFormEncoded = (type: string) => /^application\/x-www-form-urlencoded\b/i.test(type);
  const isTextLike = (type: string) => /^text\/|[/+](?:json|xml|javascript)\b/i.test(type);

  const decodeText = (text: string, type: string): unknown => {
    if (isFormEncoded(type)) return new URLSearchParams(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // The page URL when it is a usable base; otherwise (no location, or an opaque
  // one such as jsdom's default `about:blank`) http://localhost, so relative
  // URLs never make the mock reject with "Invalid URL".
  const httpBase = (): string => {
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    if (href) {
      try {
        if (/^https?:$/.test(new URL(href).protocol)) return href;
      } catch {
        // Unparseable location — fall through.
      }
    }
    return "http://localhost";
  };

  const toEffectiveRequest = (
    input: RequestInfo | URL,
    request: Request | undefined,
    init?: RequestInit,
  ): { effective: Request; rawBody: BodyInit | null | undefined } => {
    const overrides: RequestInit & { duplex?: "half" } = {};
    // Each member is read once (accessors must not answer twice differently).
    const method = init?.method;
    const headers = init?.headers;
    const body = init?.body;
    if (method !== undefined) overrides.method = method;
    if (headers !== undefined) overrides.headers = headers;
    if (body != null) {
      overrides.body = body;
      // Streaming bodies must declare half-duplex.
      if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) overrides.duplex = "half";
    }
    if (request) return { effective: new Request(request.clone(), overrides), rawBody: body };
    // Relative URLs resolve like a page's fetch() would; the original string is
    // still what routes match and the log records.
    const raw = input instanceof URL ? input.href : (input as string);
    const href = new URL(raw, httpBase()).href;
    return { effective: new Request(href, overrides), rawBody: body };
  };

  // A structured body from ANOTHER realm — jsdom's FormData, URLSearchParams or
  // Blob handed to the runtime's own Request, as in a jsdom test environment —
  // is not recognised: the runtime stringifies it ("[object FormData]") and
  // labels it text/plain. Detect that and hand the original object through.
  const FOREIGN_CONTENT_TYPE: Record<string, (raw: unknown) => string | null> = {
    FormData: () => "multipart/form-data",
    URLSearchParams: () => "application/x-www-form-urlencoded;charset=UTF-8",
    Blob: (raw) => (raw as Blob).type || null,
    File: (raw) => (raw as Blob).type || null,
  };
  const AUTO_TEXT_TYPE = /^text\/plain;charset=utf-8$/i;
  const foreignStructuredBody = async (raw: unknown): Promise<string | null> => {
    if (raw === null || typeof raw !== "object") return null;
    const tag = Object.prototype.toString.call(raw).slice(8, -1);
    if (!Object.hasOwn(FOREIGN_CONTENT_TYPE, tag)) return null;
    // Probe without the caller's headers, so an explicit Content-Type cannot
    // hide the runtime's own verdict: a recognised body gets its own type (or
    // none), an unrecognised one is stringified as text/plain.
    const probe = new Request("http://localhost/", { method: "POST", body: raw as BodyInit });
    if (!AUTO_TEXT_TYPE.test(probe.headers.get("content-type") ?? "")) return null;
    // A native URLSearchParams is always labelled form-encoded; the others must
    // also have been serialized as their "[object …]" tag.
    return tag === "URLSearchParams" || (await probe.text()) === String(raw) ? tag : null;
  };

  const decodeBody = async (effective: Request): Promise<unknown> => {
    if (effective.body === null) return undefined;
    const type = effective.headers.get("content-type") ?? "";
    if (/^multipart\/form-data\b/i.test(type)) return effective.formData();
    if (isTextLike(type) || isFormEncoded(type)) return decodeText(await effective.text(), type);
    return effective.blob();
  };

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // The signal is kept separately: it is honoured below, and is not copied into
    // the effective request (a foreign-realm signal would be rejected there).
    // An explicit `signal: null` detaches from the input Request's signal, as in
    // fetch(); only an omitted or undefined signal inherits it.
    // `init.signal` is read once, like fetch() reads the dictionary member: an
    // accessor must not be able to answer differently on a second read.
    const initSignal = init?.signal;
    const signal = initSignal === null ? undefined : (initSignal ?? request?.signal);

    if (signal?.aborted) throw abortError(signal);

    // Construction errors (a GET with a body, an invalid URL) reject exactly as
    // fetch() does.
    const { effective, rawBody } = toEffectiveRequest(input, request, init);
    const method = effective.method.toUpperCase();
    let headers = effective.headers;
    let body: unknown;
    const foreign = await foreignStructuredBody(rawBody);
    if (foreign) {
      body = rawBody;
      // Replace only the runtime's stringified label; an explicit Content-Type
      // from the caller is kept.
      if (AUTO_TEXT_TYPE.test(headers.get("content-type") ?? "")) {
        headers = new Headers(headers);
        const type = FOREIGN_CONTENT_TYPE[foreign](rawBody);
        if (type) headers.set("content-type", type);
        else headers.delete("content-type");
      }
    } else {
      body = await decodeBody(effective);
    }
    if (signal?.aborted) throw abortError(signal);

    requestLog.push({ url, method, body, timestamp: Date.now() });

    const route = matchRoute(url, method);
    if (!route) {
      return new Response(JSON.stringify({ error: "Not mocked" }), { status: 404 });
    }

    // Races `work` against the signal, so an abort rejects immediately with an
    // AbortError; the listener is removed once either side settles.
    const abortable = <T>(work: Promise<T>): Promise<T> => {
      if (!signal) return work;
      if (signal.aborted) return Promise.reject(abortError(signal));
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    };

    let mockResponse: MockResponse;
    try {
      if (typeof route.response === "function") {
        const handler = route.response;
        mockResponse = await abortable(Promise.resolve().then(() => handler({ url, method, body, headers })));
      } else {
        mockResponse = route.response;
      }
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      // Surface response-handler errors as a synthetic 500 so tests see them
      // instead of an unhandled rejection leaking past the mock boundary.
      return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
    }

    if (mockResponse.delay) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(
          new Promise<void>((r) => {
            timer = setTimeout(r, mockResponse.delay);
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    }

    return new Response(typeof mockResponse.body === "string" ? mockResponse.body : JSON.stringify(mockResponse.body), {
      status: mockResponse.status || 200,
      statusText: mockResponse.statusText || "OK",
      headers: mockResponse.headers,
    });
  };

  const restore = (): void => {
    if (hadOriginalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as unknown as Record<string, unknown>).fetch;
    }
  };

  const api = {
    /** Install the mock (replace global fetch) */
    install(): void {
      globalThis.fetch = mockFetch as typeof fetch;
    },
    /** Restore original fetch */
    restore,
    /** Add a mock route */
    addRoute(route: MockRoute): void {
      mockRoutes.push(route);
    },
    /** Remove all mock routes */
    clearRoutes(): void {
      mockRoutes.length = 0;
    },
    /** Get the request log */
    getRequests(): typeof requestLog {
      return [...requestLog];
    },
    /** Clear the request log */
    clearLog(): void {
      requestLog.length = 0;
    },
    /** Assert that a URL was called */
    assertCalled(url: string, method = "GET"): void {
      const found = requestLog.some((r) => r.url.includes(url) && r.method.toUpperCase() === method.toUpperCase());
      if (!found) throw new Error(`Expected ${method} ${url} to have been called`);
    },
    /** Assert that a URL was NOT called */
    assertNotCalled(url: string, method = "GET"): void {
      const found = requestLog.some((r) => r.url.includes(url) && r.method.toUpperCase() === method.toUpperCase());
      if (found) throw new Error(`Expected ${method} ${url} to NOT have been called`);
    },
    /** Get number of times a URL was called */
    callCount(url: string, method = "GET"): number {
      return requestLog.filter((r) => r.url.includes(url) && r.method.toUpperCase() === method.toUpperCase()).length;
    },
  };

  // Optional auto-restore via a caller-supplied afterEach hook (e.g. vitest's).
  if (typeof options.afterEach === "function") {
    options.afterEach(() => api.restore());
  }

  return api;
}

// ─── Timer Mock ─────────────────────────────────────────────────────────────

/** Smallest interval period the fake timer uses, in fake milliseconds. */
const MIN_INTERVAL_MS = 1;

/**
 * Normalize an interval period. Zero, negative and non-finite delays become
 * `MIN_INTERVAL_MS`: they stay recurring (real runtimes clamp rather than
 * turning them into one-shot timers) without an infinite same-timestamp loop.
 */
function normalizeIntervalDelay(delay: number): number {
  return Number.isFinite(delay) && delay >= MIN_INTERVAL_MS ? delay : MIN_INTERVAL_MS;
}

/**
 * Create a fake timer system for testing time-dependent code.
 * Mocks setTimeout, setInterval, requestAnimationFrame.
 */
export function createTimerMock(options: { afterEach?: (cleanup: () => void) => void } = {}) {
  const g = globalThis as unknown as Record<string, unknown>;

  // Capture originals alongside a "was it defined?" flag so restore() can
  // properly `delete` keys that were never present in the first place,
  // rather than leaving `undefined` stubs behind.
  const snapshot = (key: string) => ({
    had: Object.hasOwn(globalThis, key),
    value: g[key],
  });
  const saved = {
    setTimeout: snapshot("setTimeout"),
    setInterval: snapshot("setInterval"),
    clearTimeout: snapshot("clearTimeout"),
    clearInterval: snapshot("clearInterval"),
    requestAnimationFrame: snapshot("requestAnimationFrame"),
    cancelAnimationFrame: snapshot("cancelAnimationFrame"),
  };

  let currentTime = 0;
  let nextId = 1;
  const timers: Array<{ id: number; callback: () => void; time: number; interval?: number }> = [];

  const api = {
    install(): void {
      currentTime = 0;
      (globalThis as unknown as Record<string, unknown>).setTimeout = (cb: () => void, delay = 0) => {
        const id = nextId++;
        timers.push({ id, callback: cb, time: currentTime + delay });
        return id;
      };
      (globalThis as unknown as Record<string, unknown>).setInterval = (cb: () => void, interval: number) => {
        const id = nextId++;
        const period = normalizeIntervalDelay(interval);
        timers.push({ id, callback: cb, time: currentTime + period, interval: period });
        return id;
      };
      (globalThis as unknown as Record<string, unknown>).clearTimeout = (id: number) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx !== -1) timers.splice(idx, 1);
      };
      (globalThis as unknown as Record<string, unknown>).clearInterval = (id: number) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx !== -1) timers.splice(idx, 1);
      };
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (cb: (time: number) => void) => {
        const id = nextId++;
        timers.push({ id, callback: () => cb(currentTime), time: currentTime + 16 });
        return id;
      };
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx !== -1) timers.splice(idx, 1);
      };
    },
    restore(): void {
      for (const [key, snap] of Object.entries(saved)) {
        if (snap.had) {
          g[key] = snap.value;
        } else {
          // When an original was never defined (e.g. rAF in non-browser envs),
          // `delete` the key rather than leaving an `undefined` stub — callers
          // typically guard via `typeof requestAnimationFrame !== "undefined"`.
          delete g[key];
        }
      }
      timers.length = 0;
    },
    /** Advance time by a given number of ms, running any timers that fire */
    advance(ms: number): void {
      const targetTime = currentTime + ms;
      while (true) {
        // Sort by time and find next timer
        timers.sort((a, b) => a.time - b.time);
        const next = timers.find((t) => t.time <= targetTime);
        if (!next) break;
        currentTime = next.time;
        const idx = timers.indexOf(next);
        // `!== undefined`: an interval's period can never be 0 here (see
        // normalizeIntervalDelay), but kind must not hinge on truthiness.
        if (next.interval !== undefined) {
          next.time += next.interval;
        } else {
          timers.splice(idx, 1);
        }
        next.callback();
      }
      currentTime = targetTime;
    },
    /** Run all pending timers immediately */
    flush(): void {
      const maxIterations = 1000;
      let i = 0;
      while (timers.length > 0 && i++ < maxIterations) {
        timers.sort((a, b) => a.time - b.time);
        const next = timers[0];
        currentTime = next.time;
        if (next.interval !== undefined) {
          next.time += next.interval;
        } else {
          timers.shift();
        }
        next.callback();
      }
      // A recurring interval never drains. Stopping at the cap is correct, but
      // it must not look like a completed flush.
      if (timers.length > 0 && i > maxIterations) {
        reportError(
          new Error(
            `[createTimerMock] flush() stopped after ${maxIterations} timer runs with ${timers.length} still pending — likely a recurring interval.`,
          ),
          { phase: "scheduler", name: "createTimerMock.flush" },
        );
      }
    },
    /** Get current fake time */
    now(): number {
      return currentTime;
    },
    /** Get number of pending timers */
    pendingCount(): number {
      return timers.length;
    },
  };

  if (typeof options.afterEach === "function") {
    options.afterEach(() => api.restore());
  }

  return api;
}

// ─── DOM Snapshot Testing ───────────────────────────────────────────────────

/**
 * Create a serializable snapshot of a DOM element for comparison testing.
 */
export function createDOMSnapshot(element: Element): string {
  return serializeDom(element);
}

/**
 * Assert two DOM elements have the same structure.
 */
export function assertDOMEquals(actual: Element, expected: Element): void {
  const actualSnapshot = createDOMSnapshot(actual);
  const expectedSnapshot = createDOMSnapshot(expected);
  if (actualSnapshot !== expectedSnapshot) {
    throw new Error(`DOM mismatch:\n\nActual:\n${actualSnapshot}\n\nExpected:\n${expectedSnapshot}`);
  }
}

// ─── Component Test Wrapper ─────────────────────────────────────────────────

/**
 * Wrap a component for isolated testing with automatic cleanup.
 */
export function testComponent(
  component: (() => HTMLElement) | HTMLElement,
  options: { container?: HTMLElement } = {},
): {
  element: HTMLElement;
  container: HTMLElement;
  /** Find element by test ID (data-testid attribute) */
  getByTestId: (id: string) => Element | null;
  /** Find all elements by test ID */
  getAllByTestId: (id: string) => Element[];
  /** Find by text content */
  getByText: (text: string) => Element | null;
  /** Simulate click */
  click: (el: Element) => void;
  /** Simulate input */
  type: (el: HTMLInputElement, value: string) => void;
  /** Wait for reactive updates */
  waitForUpdate: () => Promise<void>;
  /** Clean up */
  destroy: () => void;
} {
  const container = options.container || document.createElement("div");
  if (!options.container) document.body.appendChild(container);
  const element = typeof component === "function" ? component() : component;
  container.appendChild(element);

  return {
    element,
    container,
    getByTestId(id: string) {
      return queryByAttribute(container, "data-testid", id);
    },
    getAllByTestId(id: string) {
      return queryAllByAttribute(container, "data-testid", id);
    },
    getByText(text: string) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.includes(text)) {
          return walker.currentNode.parentElement;
        }
      }
      return null;
    },
    click(el: Element) {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    type(el: HTMLInputElement, value: string) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    async waitForUpdate() {
      await new Promise((r) => setTimeout(r, 0));
    },
    destroy() {
      // Run framework disposal before detaching, so the component's effects and
      // listeners do not outlive the test.
      replaceChildrenSafely(container);
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}
