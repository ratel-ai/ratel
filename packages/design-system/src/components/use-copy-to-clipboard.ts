"use client";

import { useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

/** Copies text and keeps a short-lived, user-visible result state. */
export function useCopyToClipboard() {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyToClipboard(text: string) {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
      resetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1_500);
      return true;
    } catch (error) {
      console.error("[clipboard] copy failed:", error);
      setCopyStatus("failed");
      resetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 3_000);
      return false;
    }
  }

  return { copyStatus, copyToClipboard };
}
