"use client";

import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { FileDown, Link2 } from "lucide-react";
import { Button } from "@/components/console/health/primitives/button";

/** The shared page's two actions: copy this link, and open the PDF report. */
export function SharedPageActions({ reportHref }: { reportHref: string }) {
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        render={<a href={reportHref} target="_blank" rel="noopener" />}
        nativeButton={false}
      >
        <FileDown aria-hidden />
        Download PDF
      </Button>
      <Button variant="secondary" size="sm" onClick={() => copyToClipboard(window.location.href)}>
        <Link2 aria-hidden />
        <span aria-live="polite">
          {copyStatus === "copied"
            ? "Link copied"
            : copyStatus === "failed"
              ? "Copy failed"
              : "Copy link"}
        </span>
      </Button>
    </>
  );
}
