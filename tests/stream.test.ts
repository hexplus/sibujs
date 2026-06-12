import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/ui/stream";

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  withCredentials: boolean;
  readyState: number = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  static instances: MockEventSource[] = [];

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    if (this.onopen) this.onopen({} as Event);
  }

  simulateMessage(data: string, type = "message") {
    if (this.onmessage) this.onmessage({ data, type } as MessageEvent);
  }

  simulateError() {
    this.readyState = MockEventSource.CLOSED;
    if (this.onerror) this.onerror({} as Event);
  }
}

describe("stream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects and updates status to open", () => {
    const { status } = stream("http://localhost/events");
    expect(status()).toBe("connecting");

    const es = MockEventSource.instances[0];
    es.simulateOpen();
    expect(status()).toBe("open");
  });

  it("receives data and event type reactively", () => {
    const { data, event } = stream("http://localhost/events");
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    expect(data()).toBeNull();

    es.simulateMessage("hello", "message");
    expect(data()).toBe("hello");
    expect(event()).toBe("message");
  });

  it("sets status to closed on error", () => {
    const { status } = stream("http://localhost/events");
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    expect(status()).toBe("open");

    es.simulateError();
    expect(status()).toBe("closed");
  });

  it("closes the connection", () => {
    const { status, close } = stream("http://localhost/events");
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    close();

    expect(status()).toBe("closed");
    expect(es.close).toHaveBeenCalled();
  });

  it("dispose prevents reconnection", () => {
    const { dispose } = stream("http://localhost/events", { autoReconnect: true });
    const es = MockEventSource.instances[0];

    es.simulateOpen();
    dispose();

    // Simulate error after dispose -- should not reconnect
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("passes withCredentials option", () => {
    stream("http://localhost/events", { withCredentials: true });
    const es = MockEventSource.instances[0];
    expect(es.withCredentials).toBe(true);
  });

  it("reconnects with backoff after an error when autoReconnect is on", () => {
    vi.useFakeTimers();
    stream("http://localhost/events", { autoReconnect: true, reconnectBaseMs: 10, maxReconnects: 3 });
    const es = MockEventSource.instances[0];
    es.simulateOpen();
    es.simulateError(); // readyState CLOSED → schedules a backoff reconnect
    expect(MockEventSource.instances.length).toBe(1);
    vi.advanceTimersByTime(5000); // exceed the jittered backoff delay
    expect(MockEventSource.instances.length).toBe(2); // a new connection opened
    vi.useRealTimers();
  });

  it("close() cancels a pending reconnect timer", () => {
    vi.useFakeTimers();
    const { close } = stream("http://localhost/events", { autoReconnect: true, reconnectBaseMs: 10 });
    const es = MockEventSource.instances[0];
    es.simulateOpen();
    es.simulateError(); // schedules reconnect
    close(); // must clear the pending reconnect timer
    vi.advanceTimersByTime(5000);
    expect(MockEventSource.instances.length).toBe(1); // no reconnect fired
    vi.useRealTimers();
  });
});
