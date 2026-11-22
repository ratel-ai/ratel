import {
  catalogEntryOf,
  PLAIN_KIND_METRICS,
} from "@/lib/readings/trace-signals/self-corrections/issues";
import {
  FIX_PATTERNS,
  type FixPattern,
  fixLine,
  PLAIN_KINDS,
  type PlainKind,
} from "@/lib/readings/trace-signals/self-corrections/kinds";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import { workflowDisplayName } from "@/lib/readings/trace-signals/workflows/name";
import {
  type Ctx,
  count,
  type KindCopy,
  num,
  type Part,
  plural,
  share,
  shareText,
} from "@/lib/views/health/signals/claims-kit";

/**
 * Card copy for `self_correcting` (`self-corrections/issues.ts`): a tool
 * after which, or a task in whose runs, the agent corrects itself often.
 * Same house rules as `claims-model.ts`: whole percents, plain words, no em
 * dashes, and the fix in the words of its pattern (`kinds.ts`).
 */

/** Each plain kind as a counted noun, for the cost line ("12 retries after an error"). */
const KIND_NOUNS: Readonly<Record<PlainKind, readonly [one: string, many: string]>> = {
  retried: ["retry after an error", "retries after an error"],
  switched: ["switch to another tool", "switches to another tool"],
  gave_up: ["give-up", "give-ups"],
  searched_again: ["search again", "searches again"],
  asked_again: ["repeated ask", "repeated asks"],
  apologized: ["apology", "apologies"],
  conceded: ["concession", "concessions"],
  backtracked: ["backtrack", "backtracks"],
};

const text = (m: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = m[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

function patternOf(m: Readonly<Record<string, unknown>>): FixPattern {
  const value = m.pattern;
  return typeof value === "string" && (FIX_PATTERNS as readonly string[]).includes(value)
    ? (value as FixPattern)
    : "failed";
}

/** "12 retries after an error, 4 give-ups and 2 apologies": the three most common kinds. */
function breakdown(m: Readonly<Record<string, unknown>>): string {
  const top = PLAIN_KINDS.map((kind) => ({ kind, n: num(m, PLAIN_KIND_METRICS[kind]) }))
    .filter((entry) => entry.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map(({ kind, n }) => plural(n, ...KIND_NOUNS[kind]));
  if (top.length <= 1) return top.join("");
  return `${top.slice(0, -1).join(", ")} and ${top.at(-1)}`;
}

function selfCorrecting(c: Ctx): KindCopy {
  const { r, m, name, a, period, labels } = c;
  const k = num(m, "k");
  const n = num(m, "n", r.n);
  const stored = num(m, "share");
  const task =
    r.subjectKind === "workflow"
      ? workflowDisplayName({ id: r.subjectKey, typicalOrder: r.subjectIds }, name, labels)
      : null;
  const fixTool = text(m, "fixTool");
  const events = num(m, "events", r.impact);
  const kinds = breakdown(m);
  const parts: Part[] = task
    ? [`The agent corrects itself in ${shareText(k, n, stored)} of runs of ${task}.`]
    : [
        "The agent corrects itself after ",
        { chip: a },
        ` in ${shareText(k, n, stored)} of the turns that call it.`,
      ];
  return {
    parts,
    figure: {
      ...share(
        stored,
        `${count(k)} of ${plural(n, task ? "run" : "turn", task ? "runs" : "turns")}`,
        k,
        n,
      ),
      caption: "self-corrected",
    },
    cost: `${plural(events, "self-correction", "self-corrections")} ${period}${kinds ? `: ${kinds}` : ""}.`,
    fix: fixLine(patternOf(m), {
      tool: fixTool ? name(catalogEntryOf(fixTool).id) : task ? null : name(a),
      topic: text(m, "topicName") ?? task,
    }),
  };
}

export const SELF_CORRECTION_COPY: Pick<
  Record<SignalKind, (c: Ctx) => KindCopy>,
  "self_correcting"
> = {
  self_correcting: selfCorrecting,
};
