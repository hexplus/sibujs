export type SlotFn = () => Element | string | number | null | undefined;
export type Slots = Record<string, SlotFn>;

export function getSlot(slots: Slots | undefined, name = "default"): SlotFn | undefined {
  return slots?.[name];
}
