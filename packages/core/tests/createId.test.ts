import { beforeEach, describe, expect, it } from "vitest";
import { __resetIdCounter, createId } from "../src/core/rendering/createId";

describe("createId", () => {
  beforeEach(() => {
    __resetIdCounter();
  });

  it("generates ids with default prefix", () => {
    expect(createId()).toBe("sibu-1");
    expect(createId()).toBe("sibu-2");
  });

  it("supports custom prefix", () => {
    expect(createId("field")).toBe("field-1");
    expect(createId("field")).toBe("field-2");
  });

  it("each id is unique across prefixes (shared counter)", () => {
    const a = createId("a");
    const b = createId("b");
    expect(a).not.toBe(b);
  });
});
