import { cn } from "@ratel/design-system/cn";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { ViewRow } from "@/lib/views/session-replay/view";

/** One decision annotation in words, with a mark plus its word: never color alone. */
export function DecisionChip({ chip }: { chip: ViewRow["chips"][number] }) {
  const good = chip.tone === "good";
  const Icon = good ? CircleCheck : CircleAlert;
  return (
    <p
      data-decision-chip={chip.tone}
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-ui",
        good ? "bg-success-subtle" : "bg-danger-subtle",
      )}
    >
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={cn("mt-px size-3.5 shrink-0", good ? "text-success" : "text-danger")}
      />
      <span className="sr-only">{good ? "Good choice:" : "Questionable choice:"}</span>
      <span className="text-fg">{chip.text}</span>
    </p>
  );
}
