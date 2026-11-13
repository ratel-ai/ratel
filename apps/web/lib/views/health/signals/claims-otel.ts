import type { SignalKind } from "@/lib/readings/trace-signals/view";
import {
  type Ctx,
  count,
  duration,
  type KindCopy,
  num,
  type Part,
  plural,
  share,
  shareText,
} from "@/lib/views/health/signals/claims-kit";

/**
 * Card copy for the kinds read from OpenTelemetry (`detect-otel.ts`): what
 * each claim, figure, cost line and fix says. Same house rules as
 * `claims-model.ts`: whole percents, plain words, no em dashes.
 */

type OtelKind =
  | "tool_switch"
  | "empty_result"
  | "unknown_tool"
  | "unused_tool"
  | "long_turn"
  | "blocked_action"
  | "identical_retry"
  | "wait_heavy"
  | "token_heavy"
  | "system_turn_failing"
  | "agent_failing";

/** The agent card's tail: the tools behind its failures, as chips. */
function failingTools(ids: readonly string[]): Part[] {
  if (ids.length === 0) return ["."];
  const chips = ids.flatMap((id, i): Part[] => [
    ...(i === 0 ? [] : [i === ids.length - 1 ? " and " : ", "]),
    { chip: id },
  ]);
  return [", mostly in ", ...chips, "."];
}

/** The error code a refusal named, as the claim's tail. */
function refusedFor(code: unknown): string {
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}

/** What a failed or empty call looked like, for `tool_switch`'s sentence. */
function letDown(m: Readonly<Record<string, unknown>>): string {
  if (num(m, "byEmpty") === 0) return "fails";
  if (num(m, "byError") === 0) return "comes back empty";
  return "fails or comes back empty";
}

/** Chips for the first few never-called tools, then how many more. */
function unusedToolChips(ids: readonly string[], total: number): Part[] {
  const shown = ids.slice(0, UNUSED_CHIPS);
  const chips = shown.flatMap((id, i): Part[] => [...(i === 0 ? [] : [", "]), { chip: id }]);
  const rest = total - shown.length;
  return [...chips, rest > 0 ? ` and ${plural(rest, "more", "more")}.` : "."];
}

const UNUSED_CHIPS = 4;

/** The long-turn sentence's tail: the tools those turns lean on, as chips. */
function longTurnTools(ids: readonly string[]): Part[] {
  if (ids.length === 0) return [];
  const chips = ids.flatMap((id, i): Part[] => [
    ...(i === 0 ? [] : [i === ids.length - 1 ? " and " : ", "]),
    { chip: id },
  ]);
  return [" They lean on ", ...chips, "."];
}

export const OTEL_COPY: Pick<Record<SignalKind, (c: Ctx) => KindCopy>, OtelKind> = {
  tool_switch: ({ m, name, a, b, period }) => ({
    parts: [
      "When ",
      { chip: a },
      ` ${letDown(m)}, the agent switches to `,
      { chip: b },
      ` in ${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of the turns that call ${name(a)}.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "k"), "turn", "turns")} spent a call on ${name(a)} before reaching ${name(b)} ${period}.`,
    fix: `Say in ${name(a)}'s description when to use ${name(b)} instead, so the agent goes there first.`,
    caveat:
      num(m, "byEmpty") > 0
        ? undefined
        : "Counted from errors only. Capturing tool results also catches calls that return nothing.",
  }),
  empty_result: ({ m, name, a, period }) => ({
    parts: [
      { chip: a },
      ` returns nothing in ${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of its calls.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} calls`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "k"), "call", "calls")} came back empty ${period}.`,
    fix: `Rewrite ${name(a)}'s description to say what input it needs and when it finds nothing, so the agent stops sending asks it cannot answer.`,
    caveat: "Counted only on calls whose results were captured.",
  }),
  unknown_tool: ({ m, name, a, period }) => ({
    parts:
      num(m, "byMenu") > 0
        ? ["The agent calls ", { chip: a }, ", a tool that was not in the list it was given."]
        : ["The agent calls ", { chip: a }, ", and the call fails because no such tool exists."],
    figure: {
      value: num(m, "unknown"),
      unit: "count",
      display: count(num(m, "unknown")),
      raw: `of ${plural(num(m, "calls"), "call", "calls")}`,
    },
    cost: `${plural(num(m, "unknown"), "call", "calls")} went to a tool that does not exist ${period}.`,
    fix: `Add ${name(a)} if the agent needs it, or fix the prompt or tool list that makes the agent expect it.`,
  }),
  unused_tool: ({ r, m, period }) => ({
    parts: [
      `${plural(num(m, "tools"), "tool was", "tools were")} offered to the model on up to ${plural(num(m, "modelCalls"), "call", "calls")} and never called: `,
      ...unusedToolChips(r.subjectIds, num(m, "tools")),
    ],
    figure: {
      value: num(m, "tools"),
      unit: "count",
      display: count(num(m, "tools")),
      raw: `of ${plural(num(m, "offered"), "tool", "tools")} offered`,
    },
    cost: `Their definitions were sent with every model call ${period}, and each one costs input tokens.`,
    fix: "Leave these tools out of what you send the model, or retire them. The agent never uses them.",
  }),
  long_turn: ({ r, m, period }) => ({
    parts: [
      `${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of turns take ${count(num(m, "threshold"))} or more model calls, against ${count(num(m, "medianCalls"))} in a typical turn.`,
      ...longTurnTools(r.subjectIds),
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost:
      num(m, "inputTokens") > 0
        ? `These turns used ${shareText(num(m, "longInputTokens"), num(m, "inputTokens"))} of all input tokens ${period}.`
        : `${plural(num(m, "k"), "turn", "turns")} made ${count(num(m, "threshold"))} or more model calls ${period}.`,
    fix: "Look at these turns. When the same tools come up again and again, one tool that does the whole job saves the round trips.",
  }),
  blocked_action: ({ m, name, a, period }) => ({
    parts: [
      "The agent asks ",
      { chip: a },
      ` for things it is not allowed to do${refusedFor(m.code)}.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "calls"), "call was", "calls were")} refused for permission, plan or budget ${period}. Retrying cannot help.`,
    fix: `Tell the agent what ${name(a)} may do, or stop offering it where it will be refused.`,
  }),
  identical_retry: ({ m, name, a, period }) => ({
    parts: [
      "After ",
      { chip: a },
      ` fails, the agent sends the same call again in ${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of those turns.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "k"), "turn", "turns")} repeated a call that had just failed, unchanged ${period}.`,
    fix: `Make ${name(a)}'s errors say what to change, so the agent fixes the call instead of repeating it.`,
    caveat: "Counted only on calls whose arguments were captured.",
  }),
  wait_heavy: ({ m, name, a, period }) => ({
    parts: [
      `Turns spend ${shareText(num(m, "timeMs"), num(m, "turnMs"), num(m, "share"))} of their time waiting on `,
      { chip: a },
      `, about ${duration(num(m, "medianMs"))} a call.`,
    ],
    figure: share(
      num(m, "share"),
      `${duration(num(m, "timeMs"))} of ${duration(num(m, "turnMs"))}`,
    ),
    cost: `${plural(num(m, "calls"), "call", "calls")} held turns open for ${duration(num(m, "timeMs"))} in all ${period}.`,
    fix: `Have ${name(a)} report back when it is done, instead of holding the turn open while it waits.`,
  }),
  token_heavy: ({ m, period }) => ({
    parts: [
      `The heaviest ${shareText(num(m, "k"), num(m, "n"), num(m, "turnShare"))} of turns use ${shareText(num(m, "heavyTokens") * num(m, "k"), num(m, "totalTokens"), num(m, "tokenShare"))} of all input tokens.`,
    ],
    figure: share(num(m, "tokenShare"), `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`),
    cost: `Those turns averaged ${count(num(m, "heavyTokens"))} input tokens, against ${count(num(m, "typicalTokens"))} for a typical turn, ${period}. The largest used ${count(num(m, "maxTokens"))}.`,
    fix: "Look at these turns. Long histories and large tool results carried into every model call are the usual cause.",
  }),
  system_turn_failing: ({ m, period }) => ({
    parts: [
      `Turns started by a background task or subagent fail ${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of the time, against ${shareText(num(m, "personFailed"), num(m, "personTurns"), num(m, "personShare"))} for turns people start.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost:
      num(m, "medianMs") > 0 && num(m, "personMedianMs") > 0
        ? `${plural(num(m, "k"), "background turn", "background turns")} failed ${period}. A typical one ran ${duration(num(m, "medianMs"))}, against ${duration(num(m, "personMedianMs"))} for a person's turn.`
        : `${plural(num(m, "k"), "background turn", "background turns")} failed ${period}.`,
    fix: "Look at what these background turns are asked to do. They often lack the context a person would give.",
    caveat: "Told apart by the turn's first message, so counted only where prompts were captured.",
  }),
  agent_failing: ({ r, m, period }) => {
    const agent = typeof m.agent === "string" ? m.agent : "This";
    return {
      parts: [
        `The ${agent} agent's tool calls fail ${shareText(num(m, "k"), num(m, "n"), num(m, "share"))} of the time, against ${shareText(Math.round(num(m, "othersShare") * 100_000), 100_000, num(m, "othersShare"))} for the other agents`,
        ...failingTools(r.subjectIds),
      ],
      figure: share(
        num(m, "share"),
        `${count(num(m, "k"))} of ${count(num(m, "n"))} calls`,
        num(m, "k"),
        num(m, "n"),
      ),
      cost: `${plural(num(m, "k"), "call", "calls")} by the ${agent} agent failed ${period}, across ${plural(num(m, "turns"), "turn", "turns")}.`,
      fix: `Look at what the ${agent} agent is given to work with: its instructions, tools and inputs.`,
    };
  },
};
