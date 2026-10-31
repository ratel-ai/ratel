import { cn } from "@ratel/design-system/cn";
import { formatSpanStatus, traceStatusCode } from "@/lib/synthesis/traces/format";

export function TraceStatusBadge({
  statusCode,
  errorCount = 0,
}: {
  statusCode: number;
  errorCount?: number;
}) {
  const status = traceStatusCode(statusCode, errorCount);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        status === 2
          ? "border-coral/35 bg-coral/10 text-coral"
          : status === 1
            ? "border-green/25 bg-green/10 text-green"
            : "border-forest-300 bg-forest/45 text-cream-dim",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === 2 ? "bg-coral" : status === 1 ? "bg-green" : "bg-warm-muted",
        )}
        aria-hidden
      />
      {formatSpanStatus(status)}
    </span>
  );
}
