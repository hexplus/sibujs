import { signal } from "@sibujs/core";
import { describe, expect, it } from "vitest";
import { pagination } from "../src/ui/pagination";

describe("pagination", () => {
  it("computes totalPages correctly", () => {
    const [total] = signal(100);
    const p = pagination({ totalItems: total, pageSize: 10 });

    expect(p.totalPages()).toBe(10);
    expect(p.page()).toBe(1);
    expect(p.pageSize()).toBe(10);
  });

  it("computes startIndex and endIndex", () => {
    const [total] = signal(50);
    const p = pagination({ totalItems: total, pageSize: 10 });

    expect(p.startIndex()).toBe(0);
    expect(p.endIndex()).toBe(10);

    p.goTo(3);
    expect(p.startIndex()).toBe(20);
    expect(p.endIndex()).toBe(30);
  });

  it("navigates with next and prev", () => {
    const [total] = signal(30);
    const p = pagination({ totalItems: total, pageSize: 10 });

    expect(p.page()).toBe(1);

    p.next();
    expect(p.page()).toBe(2);

    p.next();
    expect(p.page()).toBe(3);

    // Should not go beyond totalPages
    p.next();
    expect(p.page()).toBe(3);

    p.prev();
    expect(p.page()).toBe(2);

    p.prev();
    expect(p.page()).toBe(1);

    // Should not go below 1
    p.prev();
    expect(p.page()).toBe(1);
  });

  it("goTo clamps page within valid range", () => {
    const [total] = signal(50);
    const p = pagination({ totalItems: total, pageSize: 10 });

    p.goTo(100);
    expect(p.page()).toBe(5);

    p.goTo(-1);
    expect(p.page()).toBe(1);

    p.goTo(3);
    expect(p.page()).toBe(3);
  });

  it("uses initialPage option", () => {
    const [total] = signal(100);
    const p = pagination({ totalItems: total, pageSize: 10, initialPage: 5 });

    expect(p.page()).toBe(5);
    expect(p.startIndex()).toBe(40);
    expect(p.endIndex()).toBe(50);
  });

  it("handles endIndex correctly for partial last page", () => {
    const [total] = signal(25);
    const p = pagination({ totalItems: total, pageSize: 10 });

    p.goTo(3);
    expect(p.startIndex()).toBe(20);
    expect(p.endIndex()).toBe(25); // Only 5 items on last page
  });
});
