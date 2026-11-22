"use client";

/**
 * Opens the browser's print dialog, where the reader chooses "Save as PDF".
 *
 * Deliberately not a server-rendered PDF. Printing the real page keeps the
 * charts as vectors and the text selectable, embeds the brand fonts that are
 * already served from this origin, and needs no headless browser in the
 * container image. The tradeoff is one extra dialog, which for a report an
 * operator sends a handful of times is the right trade.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-[#c4431f] bg-[#c4431f] px-3 py-1.5 text-xs font-medium text-white"
    >
      Save as PDF
    </button>
  );
}
