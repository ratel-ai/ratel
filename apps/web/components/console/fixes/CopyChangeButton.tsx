"use client";

import { Button } from "@ratel/design-system/button";
import { toast } from "@ratel/design-system/toast";
import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { Check, Copy } from "lucide-react";

/**
 * "Copy prompt": the fix as a prompt to paste into the customer's own coding
 * agent, for the fixes Cloud cannot make itself. The label says it worked.
 */
export function CopyChangeButton({
  text,
  label,
  size = "sm",
  variant = "ghost",
}: {
  text: string;
  label: string;
  size?: "sm" | "md";
  variant?: "primary" | "secondary" | "ghost";
}) {
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  return (
    <Button
      size={size}
      variant={variant}
      onClick={() => {
        void copyToClipboard(text).then((copied) => {
          if (!copied)
            toast({
              title: "Couldn't copy the prompt",
              description: "Your browser blocked the clipboard. Try again.",
              tone: "danger",
            });
        });
      }}
    >
      {copyStatus === "copied" ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
      <span aria-live="polite">{copyStatus === "copied" ? "Copied" : label}</span>
    </Button>
  );
}
