export type SlotFn = () => Element | string | number | null | undefined;
export type Slots = Record<string, SlotFn>;

/**
 * Look up a named slot factory.
 *
 * @param slots The slot map, which may be undefined.
 * @param name Slot name; defaults to `"default"`.
 * @returns The slot factory, or `undefined` when the slot was not provided.
 *   Only an OWN function-valued entry counts: an inherited member such as
 *   `toString` or `constructor` is not a slot, so fallback content renders.
 */
export function getSlot(slots: Slots | undefined, name = "default"): SlotFn | undefined {
  if (slots == null || !Object.hasOwn(slots, name)) return undefined;
  const slot = slots[name];
  return typeof slot === "function" ? slot : undefined;
}
