"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
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
      <div className="relative overflow-hidden rounded-lg border border-line bg-rail">
        <pre
          id={previewId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
          tabIndex={0}
          className="max-h-56 overflow-y-auto p-4 pb-10 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg-subtle outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <code translate="no">{prompt}</code>
        </pre>
        {/* Fades the preview's last lines so it reads as "there is more", not as a cut. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-rail"
        />
      </div>

      <button
        type="button"
        aria-controls={previewId}
        onClick={() => void copyToClipboard(prompt)}
        className={cn(buttonVariants({ variant: "primary" }), "h-10 w-full text-sm")}
      >
        {copyStatus === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span aria-live="polite">
          {copyStatus === "copied"
            ? "Copied. Paste it into your coding agent"
            : copyStatus === "failed"
              ? "Copy failed. Select the prompt and copy it"
              : "Copy this prompt for your agent"}
        </span>
      </button>
    </div>
  );
}
