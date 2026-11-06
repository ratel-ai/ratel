import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";
import type { DataProvenance } from "@/lib/synthesis/catalog/provenance";

export function PartialDataValue({
  source,
  children,
  hint,
  className,
}: {
  source: DataProvenance;
  children?: ReactNode;
  hint?: string;
  className?: string;
}) {
  if (source === "absent") {
    const explanation = hint ?? "This value was not reported.";
    return (
      <span
        role="img"
        className={cn("text-warm-muted/65", className)}
        data-provenance="absent"
        title={explanation}
        aria-label={explanation}
      >
        –
      </span>
    );
  }

  if (source === "otel") {
    const explanation = hint ?? "Approximate value reconstructed from OpenTelemetry.";
    return (
      <span
        role="img"
        className={cn("inline-flex items-baseline gap-0.5", className)}
        data-provenance="otel"
        title={explanation}
        aria-label={`${explanation} ${String(children ?? "")}`.trim()}
      >
        <span className="text-ctx-memory" aria-hidden>
          ≈
        </span>
        <span aria-hidden>{children}</span>
      </span>
    );
  }

  return (
    <span className={className} data-provenance="facts">
      {children}
    </span>
  );
}
