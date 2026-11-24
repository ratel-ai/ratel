import {
  GROUP_OF,
  groupOf,
  type HallucinationGroup,
  type HallucinationKind,
  kindOf,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { parseSentimentWindow } from "@/lib/views/traces/sentiment/page-paths";
import { CALL_PEEK, TURN_PEEK } from "@/lib/views/traces/turn-peek";

/**
 * The Hallucinations page's address: its window, the group or the one kind it
 * is narrowed to, and the kind that is open in the Panel. Everything the page shows is in the
 * URL, so a link reproduces it.
 */

/** The page opens on a month, as the other Agent health readings of outcomes do. */
const HALLUCINATIONS_DEFAULT_WINDOW_DAYS: WindowDays = 30;

/** The URL parameter that holds the open kind. */
export const KIND_PEEK = "open";

export interface HallucinationsQuery {
  /** The group the page is narrowed to: the one asked for, or the picked kind's. */
  group: HallucinationGroup | null;
  /** The one kind the page is narrowed to, inside its group. */
  kind: HallucinationKind | null;
}

const first = (raw: string | readonly string[] | undefined): string | null =>
  typeof raw === "string" ? raw : (raw?.[0] ?? null);

export function parseHallucinationsQuery(
  search: Readonly<Record<string, string | string[] | undefined>>,
): HallucinationsQuery {
  const kind = kindOf(first(search.kind) ?? "");
  return { group: kind ? GROUP_OF[kind] : groupOf(first(search.group) ?? ""), kind };
}

/** The window a page URL asks for: one of Agent health's, a month by default, within the plan's. */
export const parseHallucinationsWindow = parseSentimentWindow;

export function hallucinationsHref(
  projectId: string,
  options: {
    days?: WindowDays;
    group?: HallucinationGroup | null;
    kind?: HallucinationKind | null;
    open?: string | null;
    turn?: string | null;
    call?: string | null;
  } = {},
): string {
  const query = new URLSearchParams();
  if (options.days && options.days !== HALLUCINATIONS_DEFAULT_WINDOW_DAYS)
    query.set("days", String(options.days));
  // A kind names its group, so the address carries one or the other.
  if (options.kind) query.set("kind", options.kind);
  else if (options.group) query.set("group", options.group);
  if (options.open) query.set(KIND_PEEK, options.open);
  if (options.turn) query.set(TURN_PEEK, options.turn);
  if (options.turn && options.call) query.set(CALL_PEEK, options.call);
  const text = query.toString();
  const path = `/project/${encodeURIComponent(projectId)}/health/hallucinations`;
  return text ? `${path}?${text}` : path;
}
