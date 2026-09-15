import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard } from "../src/browser/clipboard";
import { formatCurrency } from "../src/browser/format";
import { prefetch, preloadResource } from "../src/performance/domRecycler";
import { socket } from "../src/ui/socket";
import { fileUpload } from "../src/widgets/FileUpload";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 78. clipboard(): only the latest copy() publishes.
// ---------------------------------------------------------------------------
describe("clipboard concurrent copies", () => {
  let writes: ReturnType<typeof deferred<void>>[];

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(() => {
          const d = deferred();
          writes.push(d);
          return d.promise;
        }),
      },
    });
  });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("an older copy resolving after a newer one does not overwrite it", async () => {
    const cb = clipboard();
    const p1 = cb.copy("old");
    const p2 = cb.copy("new");

    writes[1].resolve();
    await p2;
    expect(cb.text()).toBe("new");

    writes[0].resolve();
    await p1;
    expect(cb.text()).toBe("new");
    expect(cb.copied()).toBe(true);
    cb.dispose();
  });

  it("an older success after a newer success keeps the newer timer", async () => {
    const cb = clipboard();
    const p1 = cb.copy("old");
    const p2 = cb.copy("new");
    writes[1].resolve();
    await p2;
    vi.advanceTimersByTime(1500);

    writes[0].resolve();
    await p1;
    vi.advanceTimersByTime(500);

    // The newer copy's 2s flash ends on its own schedule, unextended.
    expect(cb.copied()).toBe(false);
    cb.dispose();
  });

  it("an older success does not publish after the newer copy failed", async () => {
    const cb = clipboard();
    const p1 = cb.copy("old");
    const p2 = cb.copy("new");

    writes[1].reject(new Error("denied"));
    await expect(p2).rejects.toThrow("denied");
    writes[0].resolve();
    await p1;

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
    cb.dispose();
  });

  it("a newer success still publishes after an older failure", async () => {
    const cb = clipboard();
    const p1 = cb.copy("old");
    const p2 = cb.copy("new");
    writes[0].reject(new Error("denied"));
    await expect(p1).rejects.toThrow("denied");
    writes[1].resolve();
    await p2;
    expect(cb.text()).toBe("new");
    cb.dispose();
  });

  it("disposal invalidates every pending write", async () => {
    const cb = clipboard();
    const p1 = cb.copy("a");
    const p2 = cb.copy("b");
    cb.dispose();
    writes[0].resolve();
    writes[1].resolve();
    await Promise.all([p1, p2]);
    await settle();

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 82. socket(): closing an already-closed socket stays "closed".
// ---------------------------------------------------------------------------
describe("socket close after remote close", () => {
  class MockWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWS[] = [];
    readyState = MockWS.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closeCalls = 0;
    constructor(readonly url: string) {
      MockWS.instances.push(this);
    }
    send = vi.fn();
    /** Native semantics: close() on CLOSING/CLOSED does nothing. */
    close() {
      this.closeCalls++;
      if (this.readyState === MockWS.CLOSING || this.readyState === MockWS.CLOSED) return;
      this.readyState = MockWS.CLOSING;
    }
    open() {
      this.readyState = MockWS.OPEN;
      this.onopen?.();
    }
    finishClose() {
      this.readyState = MockWS.CLOSED;
      this.onclose?.();
    }
    message(data: unknown) {
      this.onmessage?.({ data });
    }
  }

  beforeEach(() => {
    MockWS.instances = [];
    vi.stubGlobal("WebSocket", MockWS);
  });

  it("close() after a remote close keeps status closed", () => {
    const s = socket("wss://example.test");
    const native = MockWS.instances[0];
    native.open();
    native.finishClose();
    expect(s.status()).toBe("closed");

    s.close();
    s.close();

    expect(s.status()).toBe("closed");
  });

  it("dispose() after a remote close keeps status closed", () => {
    const s = socket("wss://example.test");
    MockWS.instances[0].finishClose();
    s.dispose();
    expect(s.status()).toBe("closed");
  });

  it("closing an open socket goes closing then closed", () => {
    const s = socket("wss://example.test");
    const native = MockWS.instances[0];
    native.open();

    s.close();
    expect(s.status()).toBe("closing");
    native.finishClose();
    expect(s.status()).toBe("closed");
  });

  it("closing while connecting goes closing then closed", () => {
    const s = socket("wss://example.test");
    s.close();
    expect(s.status()).toBe("closing");
    MockWS.instances[0].finishClose();
    expect(s.status()).toBe("closed");
  });

  it("stale events from a replaced socket are ignored", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const s = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 10 });
    const first = MockWS.instances[0];
    first.open();
    first.finishClose();
    vi.advanceTimersByTime(50);
    const second = MockWS.instances[1];
    second.open();
    expect(s.status()).toBe("open");

    first.message("stale");
    first.onclose?.();
    first.onopen?.();

    expect(s.status()).toBe("open");
    expect(s.data()).toBeNull();
    second.message("fresh");
    expect(s.data()).toBe("fresh");
    s.dispose();
  });
});

// ---------------------------------------------------------------------------
// 83/84. fileUpload(): reported files match committed files; empty accept tokens.
// ---------------------------------------------------------------------------
describe("fileUpload committed selection and accept tokens", () => {
  const file = (name: string, type = "") => new File(["x"], name, { type });

  it("single mode reports only the file it retained", () => {
    const onFiles = vi.fn();
    const upload = fileUpload({ multiple: false, onFiles });
    const a = file("a.png", "image/png");
    const b = file("b.png", "image/png");

    upload.addFiles([a, b]);

    expect(upload.files()).toEqual([b]);
    expect(onFiles).toHaveBeenCalledWith([b]);
  });

  it("multiple mode reports exactly the accepted batch", () => {
    const onFiles = vi.fn();
    const upload = fileUpload({ multiple: true, accept: "image/*", onFiles });
    const a = file("a.png", "image/png");
    const bad = file("doc.pdf", "application/pdf");
    const b = file("b.jpg", "image/jpeg");

    upload.addFiles([a, bad, b]);

    expect(upload.files()).toEqual([a, b]);
    expect(onFiles).toHaveBeenCalledWith([a, b]);
    expect(upload.errors()).toHaveLength(1);
  });

  it("single mode with a mix of valid and invalid files reports the retained one", () => {
    const onFiles = vi.fn();
    const upload = fileUpload({ accept: ".png", onFiles });
    const good = file("good.png");
    const bad = file("bad.exe");

    upload.addFiles([good, bad]);

    expect(upload.files()).toEqual([good]);
    expect(onFiles).toHaveBeenCalledWith(upload.files());
  });

  for (const accept of ["image/png,", ",image/png", "image/png,,", "image/png, ,", "  ,image/png"]) {
    it(`accept ${JSON.stringify(accept)} does not admit files with an empty MIME type`, () => {
      const upload = fileUpload({ accept, multiple: true });
      upload.addFiles([file("payload.exe", ""), file("ok.png", "image/png")]);
      expect(upload.files().map((f) => f.name)).toEqual(["ok.png"]);
    });
  }

  it("extensions, exact types and wildcards still match", () => {
    const upload = fileUpload({ accept: ".PDF, image/*, text/plain", multiple: true });
    upload.addFiles([
      file("report.pdf", ""),
      file("pic.webp", "image/webp"),
      file("notes.txt", "text/plain"),
      file("app.exe", "application/octet-stream"),
    ]);
    expect(upload.files().map((f) => f.name)).toEqual(["report.pdf", "pic.webp", "notes.txt"]);
  });

  it("an accept string with no valid tokens applies no restriction", () => {
    const upload = fileUpload({ accept: " , ,", multiple: true });
    upload.addFiles([file("anything.bin", "")]);
    expect(upload.files()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 85. formatCurrency(): options cannot override style or currency.
// ---------------------------------------------------------------------------
describe("formatCurrency enforced semantics", () => {
  it("a runtime cast cannot override currency or style", () => {
    const usd = formatCurrency(10, "USD", { locale: "en-US" });
    const forced = formatCurrency(10, "USD", {
      locale: "en-US",
      ...({ currency: "EUR", style: "percent" } as object),
    });
    expect(forced).toBe(usd);
    expect(forced).toContain("$");
  });

  it("ordinary options still apply", () => {
    expect(formatCurrency(1234.5, "EUR", { locale: "de-DE", minimumFractionDigits: 2 })).toMatch(/1\.234,50/);
    expect(formatCurrency(-5, "USD", { locale: "en-US", signDisplay: "always" })).toContain("-");
  });
});

// ---------------------------------------------------------------------------
// 86. Resource hints are deduplicated by URL AND hint kind.
// ---------------------------------------------------------------------------
describe("resource hint deduplication", () => {
  const links = (url: string) =>
    Array.from(document.head.querySelectorAll<HTMLLinkElement>("link")).filter((l) => l.href.endsWith(url));
  let counter = 0;
  const unique = (ext: string) => `/hint-${Date.now()}-${++counter}.${ext}`;

  it("exact duplicates are still deduplicated", () => {
    const url = unique("js");
    preloadResource(url, "script");
    preloadResource(url, "script");
    prefetch(url);
    prefetch(url);
    expect(links(url).filter((l) => l.rel === "preload")).toHaveLength(1);
    expect(links(url).filter((l) => l.rel === "prefetch")).toHaveLength(1);
  });

  it("a preload after a prefetch of the same URL is not suppressed", () => {
    const url = unique("js");
    prefetch(url);
    preloadResource(url, "script");
    const preload = links(url).find((l) => l.rel === "preload");
    expect(preload?.getAttribute("as")).toBe("script");
  });

  it("a prefetch after a preload of the same URL is not suppressed", () => {
    const url = unique("js");
    preloadResource(url, "script");
    prefetch(url);
    expect(links(url).some((l) => l.rel === "prefetch")).toBe(true);
  });

  it("the same URL preloaded with different `as` values creates both hints", () => {
    const url = unique("json");
    preloadResource(url, "fetch");
    preloadResource(url, "script");
    const kinds = links(url)
      .filter((l) => l.rel === "preload")
      .map((l) => l.getAttribute("as"))
      .sort();
    expect(kinds).toEqual(["fetch", "script"]);
    const fetchHint = links(url).find((l) => l.getAttribute("as") === "fetch");
    expect(fetchHint?.getAttribute("crossorigin")).toBe("anonymous");
  });
});
