/** The color of a line of the chart, next to its row: the same slot, so a row finds its line. */
const SLOT_COLOR = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
] as const;

export function SlotMark({ slot }: { slot: number | null }) {
  if (slot === null) return <span aria-hidden className="size-2.5 shrink-0" />;
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: SLOT_COLOR[slot] }}
    />
  );
}
