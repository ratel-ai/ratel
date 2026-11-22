import { Cpu } from "lucide-react";
import { linkedModelText, type TurnLinked } from "@/lib/views/traces/turn-linked";

/**
 * An SDK run whose agent also sends OpenTelemetry with the same session id:
 * what the user asked (from the model calls) next to what the agent searched
 * (from the SDK), and what the run spent in the model. Shown only when the
 * run linked to model calls; "Asked" and "Searched" sit side by side when
 * both were captured.
 */
export function TurnLinkedPanel({ linked }: { linked: TurnLinked }) {
  const pair = linked.asked !== null && linked.searched !== null;
  return (
    <section
      aria-label="What the model saw"
      data-turn-linked="true"
      className="flex flex-col gap-3"
    >
      {pair && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Quote label="Asked" text={linked.asked!} />
          <Quote label="Searched" text={linked.searched!} />
        </div>
      )}
      {!pair && linked.asked !== null && <Quote label="Asked" text={linked.asked} />}
      <p
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-cream-dim"
        data-turn-linked-model="true"
      >
        <Cpu aria-hidden className="size-3.5 shrink-0 text-warm-muted" />
        <span className="tabular-nums">{linkedModelText(linked)}</span>
      </p>
    </section>
  );
}

function Quote({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-forest-300 bg-forest-600/40 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 text-sm leading-6 text-cream [overflow-wrap:anywhere]">
        &ldquo;{text}&rdquo;
      </p>
    </div>
  );
}
