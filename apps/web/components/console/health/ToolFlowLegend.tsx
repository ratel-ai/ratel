import { TINT_MEANING } from "@/components/console/health/flow-copy";
import type { FlowTint } from "@/lib/readings/trace-signals/view";

/** The legend's plates, in the order a reader should care about them. */
const PLATES: readonly {
  tint: FlowTint;
  name: string;
  color: string;
  ring: number;
  dashed?: boolean;
}[] = [
  { tint: "magnet", name: "Magnet", color: "var(--color-coral)", ring: 0.95 },
  { tint: "buried", name: "Buried", color: "var(--color-ctx-tools)", ring: 0.95 },
  { tint: "dead", name: "Dead", color: "var(--color-warm-muted)", ring: 0.35, dashed: true },
  { tint: "healthy", name: "Healthy", color: "var(--color-green)", ring: 0.85 },
];

function Swatch({ color, ring, dashed }: { color: string; ring: number; dashed?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 shrink-0">
      <circle cx={7} cy={7} r={5.5} fill={color} fillOpacity={dashed ? 0 : 0.16} />
      <circle
        cx={7}
        cy={7}
        r={5.5}
        fill="none"
        stroke={color}
        strokeOpacity={ring}
        strokeWidth={1.4}
        strokeDasharray={dashed ? "2.4 2" : undefined}
      />
    </svg>
  );
}

/** Two ribbons, thin and wide: width is turns. */
function Ribbons() {
  return (
    <svg aria-hidden viewBox="0 0 28 12" className="h-3 w-7 shrink-0">
      <path
        d="M1 3 C12 3 14 9 27 9"
        fill="none"
        stroke="var(--color-cream-dim)"
        strokeOpacity={0.55}
        strokeWidth={4.5}
      />
      <path
        d="M1 10 C12 10 14 3 27 3"
        fill="none"
        stroke="var(--color-cream-dim)"
        strokeOpacity={0.8}
        strokeWidth={1.4}
      />
    </svg>
  );
}

function Bracket() {
  return (
    <svg aria-hidden viewBox="0 0 14 12" className="h-3 w-3.5 shrink-0">
      <path
        d="M1 2 H8 Q11 2 11 5 V7 Q11 10 8 10 H1"
        fill="none"
        stroke="var(--color-cream-dim)"
        strokeOpacity={0.8}
        strokeWidth={1.3}
        strokeDasharray="2.4 2.2"
      />
    </svg>
  );
}

/** A compact key under the map: four tints, ribbons, brackets. */
export function ToolFlowLegend() {
  return (
    <div
      data-flow-legend="true"
      className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] leading-4 text-warm-muted"
    >
      {PLATES.map((plate) => (
        <span
          key={plate.tint}
          className="inline-flex items-center gap-1.5"
          title={TINT_MEANING[plate.tint]}
        >
          <Swatch color={plate.color} ring={plate.ring} dashed={plate.dashed} />
          <span className="text-cream-dim">{plate.name}</span>
          <span className="hidden xl:inline">{TINT_MEANING[plate.tint].toLowerCase()}</span>
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <Ribbons />
        <span className="text-cream-dim">Wider carries more turns</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Bracket />
        <span className="text-cream-dim">Picked interchangeably</span>
      </span>
      <span className="basis-full sm:basis-auto">Rarer paths appear when you point at a tool.</span>
    </div>
  );
}
