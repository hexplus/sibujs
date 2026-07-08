import { describe, expect, it } from "vitest";
import { timeline } from "../src/patterns/timeTravel";

describe("timeline", () => {
  it("should initialize with value", () => {
    const { value } = timeline(0);
    expect(value()).toBe(0);
  });

  it("should update value", () => {
    const { value, set } = timeline(0);
    set(1);
    expect(value()).toBe(1);
    set(2);
    expect(value()).toBe(2);
  });

  it("should undo", () => {
    const { value, set, undo, canUndo } = timeline(0);
    expect(canUndo()).toBe(false);

    set(1);
    set(2);
    expect(canUndo()).toBe(true);

    undo();
    expect(value()).toBe(1);

    undo();
    expect(value()).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it("should redo", () => {
    const { value, set, undo, redo, canRedo } = timeline(0);
    set(1);
    set(2);
    expect(canRedo()).toBe(false);

    undo();
    expect(canRedo()).toBe(true);

    redo();
    expect(value()).toBe(2);
    expect(canRedo()).toBe(false);
  });

  it("should clear redo history on new set", () => {
    const { value, set, undo, canRedo } = timeline(0);
    set(1);
    set(2);
    undo();
    expect(canRedo()).toBe(true);

    set(3); // Should clear redo history
    expect(canRedo()).toBe(false);
    expect(value()).toBe(3);
  });

  it("should expose history", () => {
    const { history, set, index } = timeline(0);
    set(1);
    set(2);
    expect(history()).toEqual([0, 1, 2]);
    expect(index()).toBe(2);
  });

  it("should reset", () => {
    const { value, set, reset, history } = timeline(0);
    set(1);
    set(2);
    reset();
    expect(value()).toBe(0);
    expect(history()).toEqual([0]);
  });

  it("should jumpTo index", () => {
    const { value, set, jumpTo } = timeline(0);
    set(1);
    set(2);
    set(3);
    jumpTo(1);
    expect(value()).toBe(1);
  });

  it("should use updater function", () => {
    const { value, set } = timeline(0);
    set((prev) => prev + 10);
    expect(value()).toBe(10);
  });
});
