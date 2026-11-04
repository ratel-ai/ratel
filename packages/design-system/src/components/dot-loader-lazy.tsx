import { cn } from "../cn";
import { DotLoader } from "./dot-matrix";

/**
 * Upstream's name for the dot loader where the server renders too. This loader is CSS only, so it
 * needs no lazy load; `tone="neutral"` draws it in the subtle text color.
 */
export function DotLoaderLazy({
  label,
  size = "md",
  tone,
  className,
}: {
  label: string;
  size?: "sm" | "md";
  tone?: "neutral";
  className?: string;
}) {
  return (
    <DotLoader
      label={label}
      size={size}
      className={cn(tone === "neutral" && "text-fg-subtle", className)}
    />
  );
}
