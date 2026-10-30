import { SITE_COPILOT_DAYS, siteCalendar } from "./site-copilot-otlp";
import type { SitePlan } from "./site-copilot-plan";
import { SITE_TOPICS } from "./site-copilot-turns";

const DAY_MS = 86_400_000;
const TOPICS: readonly string[] = SITE_TOPICS;

/**
 * The capability searches behind the plan's turns, as the SDK sends them: one per turn that opens a
 * topic and calls a tool, with the user's ask as the query. Follow-ups ("Try again?") stay out, since
 * these become the real prompts Test a search offers. No hits, so the tool counters stay the spans'.
 */
export function siteCopilotSearchEvents(plan: SitePlan, opts: { anchorMs: number }) {
  const calendar = siteCalendar(opts.anchorMs - SITE_COPILOT_DAYS * DAY_MS, opts.anchorMs);
  return plan.conversations.flatMap((conversation) => {
    let at = calendar(conversation.position);
    return conversation.turns.flatMap((turn) => {
      at += turn.gapBeforeMs;
      if (!TOPICS.includes(turn.kind) || turn.calls.length === 0) return [];
      return [
        {
          v: 1,
          type: "search" as const,
          ts: Math.min(at, opts.anchorMs),
          session_id: conversation.id,
          client_event_id: `site-copilot-search-${turn.key}`,
          query: turn.ask,
        },
      ];
    });
  });
}
