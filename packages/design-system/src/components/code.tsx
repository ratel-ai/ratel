"use client";

import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../cn";
import { IconButton } from "./button";
import { maskSecret } from "./mask";
import { SegmentedControl } from "./tabs";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

export type CodeSample = { label: string; code: string };

/**
 * A snippet with copy. Several samples (curl / TypeScript / Python) share one
 * frame with a switch, so a quickstart is one block, not three.
 */
export function CodeBlock({
  samples,
  caption,
  onCopy,
  wrap = false,
  className,
}: {
  samples: readonly CodeSample[];
  /** A short label on the left of the bar: "Request", "Response". */
  caption?: ReactNode;
  /** Called after the copy button is pressed, with the sample on show (analytics). */
  onCopy?: (sample: CodeSample) => void;
  /** Wraps long lines instead of scrolling them: for prose to paste (a prompt), not for code. */
  wrap?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState(samples[0]?.label ?? "");
  const sample = samples.find((item) => item.label === active) ?? samples[0];
  if (!sample) return null;
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-rail", className)}>
      <div className="flex h-10 items-center gap-2 border-b border-line pr-1.5 pl-3">
        {caption ? <span className="text-xs font-medium text-fg-subtle">{caption}</span> : null}
        {samples.length > 1 ? (
          <SegmentedControl
            label="Language"
            options={samples.map((item) => ({ value: item.label, label: item.label }))}
            value={sample.label}
            onValueChange={setActive}
            className="ml-auto"
          />
        ) : (
          <span className="ml-auto" />
        )}
        <CopyButton
          text={sample.code}
          label="Copy code"
          onCopy={onCopy ? () => onCopy(sample) : undefined}
        />
      </div>
      {/* Focusable so keyboard users can scroll long lines. */}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
        tabIndex={0}
        className={cn(
          "p-3 font-mono text-xs leading-5 text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
          wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto",
        )}
      >
        <code translate="no">{sample.code}</code>
      </pre>
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  onCopy,
}: {
  text: string;
  label?: string;
  /** Called once the copy was attempted, with whether it reached the clipboard. */
  onCopy?: (copied: boolean) => void;
}) {
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  return (
    <IconButton
      label={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : label}
      size="icon-sm"
      icon={copyStatus === "copied" ? <Check className="text-success" /> : <Copy />}
      onClick={() => {
        void copyToClipboard(text).then((copied) => onCopy?.(copied));
      }}
    />
  );
}

/** A secret shown masked, revealed on request, copied in one click. */
export function KeyReveal({
  value,
  label = "API key",
  onCopy,
}: {
  value: string;
  label?: string;
  /** Called after the secret reached the clipboard. */
  onCopy?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex h-9 items-center gap-1 rounded-md border border-line-strong bg-app pr-1 pl-3">
      <span className="sr-only">{label}: </span>
      <code translate="no" className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
        {shown ? value : maskSecret(value)}
      </code>
      <IconButton
        label={shown ? "Hide key" : "Show key"}
        size="icon-sm"
        icon={shown ? <EyeOff /> : <Eye />}
        onClick={() => setShown((current) => !current)}
      />
      <CopyButton
        text={value}
        label="Copy key"
        onCopy={(copied) => {
          if (copied) onCopy?.();
        }}
      />
    </div>
  );
}
