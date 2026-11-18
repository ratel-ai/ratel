import type { ReactNode } from "react";

/**
 * A collapsed explanation that costs nothing until it is opened.
 *
 * The console has two readers in one page: someone checking the number, and
 * someone checking whether to believe the number. Printing the method inline
 * serves the second and buries the first. A native `<details>` keeps both
 * served, needs no client JavaScript, and stays open across a print.
 */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="q-disclosure">
      <summary>{summary}</summary>
      <div className="q-disclosure-body">{children}</div>
    </details>
  );
}

/** A labelled fact inside a disclosure. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="q-fact">
      <span className="q-fact-label">{label}</span>
      {children}
    </p>
  );
}
