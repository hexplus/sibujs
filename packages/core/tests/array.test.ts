import { describe, expect, it } from "vitest";
import { array } from "../src/core/signals/array";

describe("array", () => {
  it("should initialize with array", () => {
    const [items] = array([1, 2, 3]);
    expect(items()).toEqual([1, 2, 3]);
  });

  it("should push items", () => {
    const [items, { push }] = array<number>([1]);
    push(2, 3);
    expect(items()).toEqual([1, 2, 3]);
  });

  it("should pop items", () => {
    const [items, { pop }] = array([1, 2, 3]);
    const removed = pop();
    expect(removed).toBe(3);
    expect(items()).toEqual([1, 2]);
  });

  it("should shift items", () => {
    const [items, { shift }] = array([1, 2, 3]);
    const removed = shift();
    expect(removed).toBe(1);
    expect(items()).toEqual([2, 3]);
  });

  it("should unshift items", () => {
    const [items, { unshift }] = array([2, 3]);
    unshift(0, 1);
    expect(items()).toEqual([0, 1, 2, 3]);
  });

  it("should splice items", () => {
    const [items, { splice }] = array([1, 2, 3, 4]);
    const removed = splice(1, 2, 10, 20);
    expect(removed).toEqual([2, 3]);
    expect(items()).toEqual([1, 10, 20, 4]);
  });

  it("should remove by index", () => {
    const [items, { remove }] = array(["a", "b", "c"]);
    remove(1);
    expect(items()).toEqual(["a", "c"]);
  });

  it("should removeWhere", () => {
    const [items, { removeWhere }] = array([1, 2, 3, 4]);
    removeWhere((x) => x === 3);
    expect(items()).toEqual([1, 2, 4]);
  });

  it("should update at index", () => {
    const [items, { update }] = array(["a", "b", "c"]);
    update(1, "B");
    expect(items()).toEqual(["a", "B", "c"]);
  });

  it("should clear", () => {
    const [items, { clear }] = array([1, 2, 3]);
    clear();
    expect(items()).toEqual([]);
  });

  it("should sort", () => {
    const [items, { sort }] = array([3, 1, 2]);
    sort((a, b) => a - b);
    expect(items()).toEqual([1, 2, 3]);
  });

  it("should reverse", () => {
    const [items, { reverse }] = array([1, 2, 3]);
    reverse();
    expect(items()).toEqual([3, 2, 1]);
  });
});
