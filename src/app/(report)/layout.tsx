import type { ReactNode } from "react";
import "./report.css";

/**
 * The print surface, deliberately outside the console route group.
 *
 * Nesting it under `(console)` would inherit the console's rail and header, and a nested layout
 * composes rather than replaces, so there would be no way to shed them. A sibling group gives the
 * report a bare page that prints as itself. Authorization is not inherited either, so every page
 * in here gates on its own.
 */
export default function ReportLayout({ children }: { children: ReactNode }) {
  return children;
}
