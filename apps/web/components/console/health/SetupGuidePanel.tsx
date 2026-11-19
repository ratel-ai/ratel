"use client";

import { cn } from "@ratel/design-system/cn";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { SetupPill } from "@/components/console/health/setup-card-model";
import { type SetupStack, STACK_LABEL } from "@/components/console/health/setup-guides";

export interface SetupGuidePanelProps {
  pill: SetupPill;
  /** The stack the reader last picked, kept across pills while it applies. */
  stack: SetupStack | null;
  onStack: (stack: SetupStack) => void;
  /** What already arrives, named once in the footer. */
  received?: readonly SetupPill[];
}

/**
 * How to turn one data point on: what it adds, a switch between the common
 * stacks, and the snippet with a copy button.
 */
export function SetupGuidePanel({ pill, stack, onStack, received = [] }: SetupGuidePanelProps) {
  const guide = pill.guides.find((g) => g.stack === stack) ?? pill.guides[0];
  if (!guide) return null;
  return (
    <div
      data-setup-guide={pill.key}
      className="rounded-xl border border-forest-300 bg-base-deep/50 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[13px] leading-5 text-cream">
          <span className="font-medium">{pill.label}: </span>
          <span className="text-cream-dim">{pill.unlocks}</span>
        </p>
        {pill.guides.length > 1 && (
          <div
            role="radiogroup"
            aria-label="Your stack"
            className="flex max-w-full flex-wrap gap-1"
          >
            {pill.guides.map((option) => (
              <button
                key={option.stack}
                type="button"
                role="radio"
                aria-checked={option.stack === guide.stack}
                onClick={() => onStack(option.stack)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-coral",
                  option.stack === guide.stack
                    ? "bg-cream text-ink"
                    : "bg-forest-600/60 text-warm-muted hover:text-cream",
                )}
              >
                {STACK_LABEL[option.stack]}
              </button>
            ))}
          </div>
        )}
      </div>
      <CodeBlock code={guide.code} stack={STACK_LABEL[guide.stack]} />
      {guide.note && <p className="mt-2 text-[12px] leading-5 text-warm-muted">{guide.note}</p>}
      {received.length > 0 && (
        <p
          data-setup-received="true"
          className="mt-2 border-t border-forest-300/60 pt-2 text-[11px] leading-5 text-warm-muted"
        >
          Already received: {received.map((r) => r.label).join(", ")}
        </p>
      )}
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CodeBlock({ code, stack }: { code: string; stack: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      // The clipboard is refused (no permission, insecure page): say so, the snippet stays selectable.
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1_600);
  };
  return (
    <div className="relative mt-2.5 overflow-hidden rounded-lg border border-forest-300 bg-base-deep">
      <div className="flex items-center justify-between border-b border-forest-300 py-1 pl-3 pr-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
          {stack}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-warm-muted transition-colors hover:bg-forest hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          {state === "copied" ? (
            <Check aria-hidden className="size-3 text-green" />
          ) : (
            <Copy aria-hidden className="size-3" />
          )}
          <span aria-live="polite">
            {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
          </span>
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-5 text-cream">
        <code>{code}</code>
      </pre>
    </div>
  );
}
