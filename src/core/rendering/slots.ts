export type SlotFn = () => Element | string | number | null | undefined;
export type Slots = Record<string, SlotFn>;

/**
 * Look up a named slot factory.
 *
 * @param slots The slot map, which may be undefined.
 * @param name Slot name; defaults to `"default"`.
 * @returns The slot factory, or `undefined` when the slot was not provided.
 */
export function getSlot(slots: Slots | undefined, name = "default"): SlotFn | undefined {
  return slots?.[name];
}
