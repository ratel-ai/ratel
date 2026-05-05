/** A slot is either a concrete tool name or an array of alternatives (any one satisfies). */
export type ToolSlot = string | string[];

export function toolMatchesSlot(tool: string, slot: ToolSlot): boolean {
  return Array.isArray(slot) ? slot.includes(tool) : tool === slot;
}

export function slotRecall(called: string[], slots: ToolSlot[]): number {
  if (slots.length === 0) return 1;
  const unique = new Set(called);
  const satisfied = slots.filter((slot) =>
    [...unique].some((t) => toolMatchesSlot(t, slot)),
  ).length;
  return satisfied / slots.length;
}

export function slotPrecision(called: string[], slots: ToolSlot[]): number {
  const unique = new Set(called);
  if (unique.size === 0 && slots.length === 0) return 1;
  if (unique.size === 0) return 1; // nothing selected, nothing wrong
  if (slots.length === 0) return 0; // selected tools but none expected

  const matching = [...unique].filter((t) =>
    slots.some((slot) => toolMatchesSlot(t, slot)),
  ).length;
  return matching / unique.size;
}

export function flattenSlots(slots: ToolSlot[]): string[] {
  const set = new Set<string>();
  for (const slot of slots) {
    if (Array.isArray(slot)) {
      for (const t of slot) set.add(t);
    } else {
      set.add(slot);
    }
  }
  return [...set];
}

export function formatSlots(slots: ToolSlot[]): string {
  if (slots.length === 0) return "(none)";
  return slots
    .map((slot) => (Array.isArray(slot) ? slot.join("|") : slot))
    .join(", ");
}
