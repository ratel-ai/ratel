import type { DailyRate } from "./adapters/run-scores";
import type { Scorer, ScorerDefinition, ScorerKind } from "./domain/types";

/**
 * RC-615: what the scorer list and the detail page show. Pure. Engine names
 * stay out: a kind reads as what it does, not as the library behind it.
 * RC-658: the kind names of the UX audit term list (RC-656): "Field check"
 * and "JSON rule", so "check" and "rule" mean nothing else.
 */

export const KIND_LABELS: Record<ScorerKind, string> = {
  check: "Field check",
  expression: "JSON rule",
  judge: "Model judge",
  decision: "Model question",
};

export const KIND_HELP: Record<ScorerKind, string> = {
  check:
    "Compare one run field with a value: time, cost, a tool it called, an argument or the text.",
  expression: "A logic rule over the whole run, written as JSON.",
  judge: "A model reads the run and your criteria, and says pass or fail.",
  decision: "A model answers one question about the run from your options.",
};

/** A new scorer's starting config, for the kind picker. Each one passes save-time validation. */
export const STARTER_DEFINITIONS: Record<ScorerKind, ScorerDefinition> = {
  check: { kind: "check", config: { path: "latencyMs", op: "lte", value: 30_000 } },
  expression: { kind: "expression", config: { logic: { "<=": [{ var: "toolCallCount" }, 10] } } },
  judge: { kind: "judge", config: { criteria: "The agent completes the user's request." } },
  decision: {
    kind: "decision",
    config: {
      question: "Did the agent complete the request?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      pass: ["yes"],
    },
  },
};

export const STARTER_NAMES: Record<ScorerKind, string> = {
  check: "Finishes in 30 s",
  expression: "At most 10 tool calls",
  judge: "Completes the request",
  decision: "Request done",
};

export interface ScorerRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  builtIn: boolean;
  /** Passed over scored in the window; null when nothing was scored. */
  passRate: number | null;
  /** Pass rate per day, oldest first; days with nothing scored are 0. */
  trend: number[];
  href: string;
}

/** One row per scorer: the user's first, then the built-in ones. */
export function scorerRows(input: {
  own: readonly Scorer[];
  builtIn: readonly { id: string; name: string; enabled: boolean; rates: readonly DailyRate[] }[];
  rates: ReadonlyMap<string, readonly DailyRate[]>;
  days: readonly string[];
  hrefOf: (id: string) => string;
}): ScorerRow[] {
  const row = (
    id: string,
    name: string,
    kind: string,
    enabled: boolean,
    builtIn: boolean,
    rates: readonly DailyRate[],
  ): ScorerRow => {
    const byDay = new Map(rates.map((rate) => [rate.day, rate]));
    const window = input.days.map((day) => byDay.get(day));
    const n = window.reduce((sum, rate) => sum + (rate?.n ?? 0), 0);
    const passed = window.reduce((sum, rate) => sum + (rate?.passed ?? 0), 0);
    return {
      id,
      name,
      kind,
      enabled,
      builtIn,
      passRate: n === 0 ? null : passed / n,
      trend: window.map((rate) => (rate && rate.n > 0 ? rate.passed / rate.n : 0)),
      href: input.hrefOf(id),
    };
  };
  return [
    ...input.own.map((scorer) =>
      row(
        scorer.id,
        scorer.name,
        KIND_LABELS[scorer.kind],
        scorer.enabled,
        false,
        input.rates.get(scorer.id) ?? [],
      ),
    ),
    ...input.builtIn.map((scorer) =>
      row(scorer.id, scorer.name, "Built-in", scorer.enabled, true, scorer.rates),
    ),
  ];
}

/** The last `count` UTC days up to `today`, oldest first. */
export function lastDays(today: string, count = 14): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - (count - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

export function taskScorerHref(projectId: string, taskId: string, scorerId: string): string {
  return `/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/scorers/${encodeURIComponent(scorerId)}`;
}

export function suiteScorerHref(projectId: string, scorerId: string): string {
  return `/project/${encodeURIComponent(projectId)}/evals/scorers/${encodeURIComponent(scorerId)}`;
}
