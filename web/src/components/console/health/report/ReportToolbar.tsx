"use client";

import { useEffect } from "react";

/**
 * The screen-only bar above the report, and the print dialog itself: with
 * `autoPrint` (the Download PDF buttons open the report that way) the dialog
 * opens as soon as the page has painted, where the reader picks "Save as PDF".
 */
export function ReportToolbar({ autoPrint }: { autoPrint: boolean }) {
  useEffect(() => {
    if (!autoPrint) return;
    // Let fonts settle first, or the PDF can pick up the fallback face.
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [autoPrint]);
  return (
    <div className="hr-toolbar">
      <span>A4 report. Choose &ldquo;Save as PDF&rdquo; in the print dialog.</span>
      <button type="button" onClick={() => window.print()}>
        Download PDF
      </button>
    </div>
  );
}
