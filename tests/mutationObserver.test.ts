import { describe, expect, it } from "vitest";
import { mutationObserver } from "../src/browser/mutationObserver";

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("mutationObserver", () => {
  it("emits records when children are added", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const obs = mutationObserver(host, { childList: true });
    expect(obs.records()).toEqual([]);

    host.appendChild(document.createElement("span"));
    await flush();

    const records = obs.records();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].type).toBe("childList");

    obs.dispose();
    document.body.removeChild(host);
  });

  it("dispose disconnects the observer", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const obs = mutationObserver(host, { childList: true });
    obs.dispose();
    host.appendChild(document.createElement("span"));
    await flush();
    expect(obs.records()).toEqual([]);
    document.body.removeChild(host);
  });
});
