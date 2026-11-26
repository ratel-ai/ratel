"use client";

import { cn } from "@ratel/design-system/cn";
import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { Check, Copy } from "lucide-react";
import { useId, useMemo } from "react";
import { type AgentPromptTarget, buildAgentPrompt } from "@/lib/console/onboarding/agent-prompt";

/**
 * The Agent tab, and the page's one call to action: copy a prompt and hand the
 * integration to the coding agent already working in the customer's repo. The
 * prompt is built in lib/console/onboarding/agent-prompt.ts (pure, tested); this
 * shows it, so nobody pastes something they have not read, and copies it.
 */
export function AgentPromptPanel({
  className,
  ...target
}: AgentPromptTarget & { className?: string }) {
  const { projectName, serviceName, endpoint, tracesUrl, captureContent } = target;
  const prompt = useMemo(
    () => buildAgentPrompt({ projectName, serviceName, endpoint, tracesUrl, captureContent }),
    [projectName, serviceName, endpoint, tracesUrl, captureContent],
  );
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  const previewId = useId();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="relative overflow-hidden rounded-lg border border-forest-300/70 bg-base-deep/70">
        <div className="flex h-9 items-center justify-between border-b border-forest-300/70 px-3">
          <span id={`${previewId}-title`} className="text-xs font-medium text-cream-dim">
            Prompt for your coding agent
          </span>
          <span className="font-mono text-[11px] text-warm-muted">
            {prompt.split("\n").length} lines
          </span>
        </div>
        <pre
          id={previewId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
          tabIndex={0}
          className="max-h-80 overflow-y-auto lg:max-h-[31rem] p-3 pb-10 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-cream-dim outline-none focus-visible:ring-2 focus-visible:ring-coral focus-visible:ring-inset"
        >
          <code translate="no">{prompt}</code>
        </pre>
        {/* Fades the preview's last lines so it reads as "there is more", not as a cut. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-base-deep"
        />
      </div>

      <button
        type="button"
        aria-controls={previewId}
        onClick={() => void copyToClipboard(prompt)}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-coral px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors duration-120 hover:bg-coral-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
      >
        {copyStatus === "copied" ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
        <span aria-live="polite">
          {copyStatus === "copied"
            ? "Copied: paste it into your agent"
            : copyStatus === "failed"
              ? "Copy failed: select the prompt and copy it"
              : "Copy this prompt for your agent"}
        </span>
      </button>
      <p className="text-pretty text-center text-xs leading-relaxed text-warm-muted">
        Paste it into Claude Code, Codex, Cursor or any coding agent, in the repo where your agent
        lives. It wires Ratel in and checks that the first trace arrives.
      </p>
    </div>
  );
}
