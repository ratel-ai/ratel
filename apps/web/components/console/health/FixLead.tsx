import { cn } from "@ratel/design-system/cn";

/**
 * "What to do:" and the fix's first sentence, at the top of an opened problem
 * row. The row's toggle names it as its description (`aria-describedby`).
 */
export function FixLead({ id, lead, className }: { id: string; lead: string; className?: string }) {
  return (
    <p
      id={id}
      data-signal-fix-lead="true"
      className={cn("pb-3 text-pretty text-[13px] leading-5 text-cream-dim", className)}
    >
      <span className="font-medium text-cream">What to do:</span> {lead}
    </p>
  );
}
