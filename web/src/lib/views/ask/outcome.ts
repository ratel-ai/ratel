import type { WidgetInput } from "@/lib/views/dashboards/types";
import { canonicalJson } from "@/lib/views/dashboards/widget";
import type { AskOutcome } from "./domain";

/**
 * What a dialog of Ask in words stores as the outcome of an ask (decision `ask-in-words`), and
 * when its chart shows. Pure and safe for the browser.
 *
 * The outcome: kept when the person saved the drafted widgets unchanged, edited when they saved
 * them after a change, discarded when they saved nothing of them (the dialog closed, or another
 * ask replaced the draft).
 */

/** The parts of a widget that a person can change: its title, query and chart. */
type Shown = Pick<WidgetInput, "title" | "query" | "chart">;

/** The outcome of one draft, from what was drafted and what was saved (null: nothing was saved). */
export function askOutcome(drafted: readonly Shown[], saved: readonly Shown[] | null): AskOutcome {
  if (!saved || saved.length === 0) return "discarded";
  if (saved.length !== drafted.length) return "edited";
  return saved.every((widget, index) => same(widget, drafted[index])) ? "kept" : "edited";
}

/**
 * Whether a change is a choice that shows the chart: a metric, a kind or an edit of the RQL, that
 * is a change of the query or the chart. A title alone is no choice.
 */
export function isChoice(before: WidgetInput, after: WidgetInput): boolean {
  return (
    canonicalJson({ query: before.query, chart: before.chart }) !==
    canonicalJson({ query: after.query, chart: after.chart })
  );
}

function same(a: Shown, b: Shown | undefined): boolean {
  if (!b) return false;
  return (
    canonicalJson({ title: a.title.trim(), query: a.query, chart: a.chart }) ===
    canonicalJson({ title: b.title.trim(), query: b.query, chart: b.chart })
  );
}
