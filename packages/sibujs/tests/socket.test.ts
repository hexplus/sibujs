import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { socket } from "../src/ui/socket";

const _tick = () => new Promise((r) => setTimeout(r, 0));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  protocols?: string | string[];
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  static instances: MockWebSocket[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({} as CloseEvent);
    }
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen({} as Event);
  }

  simulateMessage(data: string) {
    if (this.onmessage) this.onmessage({ data } as MessageEvent);
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({} as CloseEvent);
  }

  simulateError() {
    if (this.onerror) this.onerror({} as Event);
  }
}

describe("socket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects and updates status to open", () => {
    const { status } = socket("ws://localhost");
    expect(status()).toBe("connecting");

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    expect(status()).toBe("open");
  });

  it("receives data reactively", () => {
    const { data } = socket("ws://localhost");
    const ws = MockWebSocket.instances[0];

    ws.simulateOpen();
    ws.simulateMessage("hello");
    expect(data()).toBe("hello");

    ws.simulateMessage("world");
    expect(data()).toBe("world");
  });

  it("sends data through WebSocket", () => {
    const { send } = socket("ws://localhost");
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    send("test-message");
    expect(ws.send).toHaveBeenCalledWith("test-message");
  });

  it("auto-reconnects when enabled", () => {
    vi.useFakeTimers();
    const { status } = socket("ws://localhost", {
      autoReconnect: true,
      reconnectDelay: 500,
      maxReconnects: 3,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose();

    expect(status()).toBe("closed");
    vi.advanceTimersByTime(500);

    // A new WebSocket should have been created
    expect(MockWebSocket.instances.length).toBe(2);
    expect(status()).toBe("connecting");
  });

  it("respects maxReconnects limit", () => {
    vi.useFakeTimers();
    socket("ws://localhost", {
      autoReconnect: true,
      reconnectDelay: 100,
      maxReconnects: 2,
    });

    // Close without opening (no successful connection, so reconnectCount keeps incrementing)
    for (let i = 0; i < 3; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.simulateClose();
      vi.advanceTimersByTime(100);
    }

    // 1 initial + 2 reconnects = 3 total (third close should not reconnect)
    expect(MockWebSocket.instances.length).toBe(3);
  });

  it("dispose stops reconnection and closes", () => {
    vi.useFakeTimers();
    const { dispose } = socket("ws://localhost", {
      autoReconnect: true,
      reconnectDelay: 100,
    });

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    dispose();
    vi.advanceTimersByTime(1000);

    // Should not have created a new connection after dispose
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("runs a heartbeat while open and stops it on close", () => {
    vi.useFakeTimers();
    const sock = socket("ws://localhost", { heartbeat: { interval: 100, message: "ping" } });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen(); // starts the heartbeat interval
    vi.advanceTimersByTime(100);
    expect(ws.send).toHaveBeenCalledWith("ping");

    sock.close(); // stopHeartbeat clears the interval
    ws.send.mockClear();
    vi.advanceTimersByTime(500);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("close() cancels a pending reconnect timer", () => {
    vi.useFakeTimers();
    const { close } = socket("ws://localhost", { autoReconnect: true, reconnectDelay: 500 });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose(); // schedules a reconnect
    close(); // must clear the pending reconnect timer
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances.length).toBe(1); // no reconnect fired
  });
});
