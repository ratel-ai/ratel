import type { CloudMessage, ContentBlock } from "@/lib/ingest/cloud-schema";
import { costFor, priceFor } from "@/lib/ingest/pricing";
import { getLogger } from "@/lib/platform/logger";
import type { ModelCall } from "./calls";
import { CANT_SIMULATE } from "./method";
import {
  AGENT_MAX_TOKENS,
  type AgentModel,
  type AgentReply,
  type EvalModels,
  estimateTokens,
  ModelRefused,
  type ReplayCall,
  type ReplayMessage,
  recordBudgetRefusal,
  SMALL_MAX_TOKENS,
  type SpendMeter,
  type ToolStandIn,
} from "./models";
import type {
  CraftedToolDef,
  FixChange,
  InvokeStep,
  ReplayFacts,
  ReplayStop,
  RunRecord,
  RunView,
  ToolDef,
} from "./types";

/**
 * Model-in-the-loop replay (RC-61): a stored run's recorded conversation,
 * given back to a model with and without the fix, to see what it does next.
 *
 * A run's model calls (`calls.ts`) are its decision points. The replay starts
 * at the first one, with the same conversation so far and the same system
 * prompt, offers every tool the run was offered, and asks the model for its
 * next action until it answers or hits the step cap. A tool call is answered
 * from the recording when it matches one (the same tool and the arguments the
 * recording passed, in the
 * order they were used, so a retry fails again like it did), a merged tool
 * from its sources' recorded results, and anything else by a stand-in model,
 * counted per run. Both sides run with the same model and the same rules, so
 * the replay's own drift cancels in the difference; how often the side without
 * the fix took the recorded path is reported as the replay's fidelity.
 *
 * RC-76: the side without the fix is the baseline, so it must take the
 * recorded path (a call the conversation already answered before the run, a
 * re-read, doesn't count against it). When it doesn't, the run isn't scored
 * and the side with the fix isn't paid for. The side with the fix is scored on
 * its outcome, not on its path: a merge is held to doing the work the run did
 * (`paths.intended`, the recorded path with the merged tool in place of its
 * sources). Each side's path and how it stopped are kept, for the eval page.
 *
 * Nothing runs against the customer's agent or tools, and nothing textual from
 * the replay is kept: the result is tool names, outcomes and numbers.
 */

const logger = getLogger("eval-gate/replay");
/** The tool stand-in's own instructions, on top of what it is given, for its estimate. */
const STAND_IN_PROMPT_TOKENS = 500;

/* - Reading the recording ---------------------------------------------------- */

export interface RecordedCall extends ReplayCall {
  result: string;
  isError: boolean;
}

export interface Recording {
  /** The conversation before the run's first decision. */
  history: ReplayMessage[];
  system: string | undefined;
  /** Every tool the run was offered, deduped by name. */
  tools: ToolDef[];
  /** The calls the run made, with their recorded results. */
  calls: RecordedCall[];
  /** RC-76: calls the conversation made and answered before the run (earlier turns): a replay that repeats one gets the same answer. */
  earlier: RecordedCall[];
  model: string | null;
  /** Mean recorded tool time per call, for the replay's time. */
  toolMs: number;
  /** The most input tokens one of the run's model calls recorded (0 when none did): the floor of a replay call's estimate. */
  inputTokens: number;
}

function blocksOf(content: CloudMessage["content"]): ContentBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Recorded messages as the replay keeps them. A tool result says whether it failed (an `error` field). */
export function toReplayMessages(messages: readonly CloudMessage[]): ReplayMessage[] {
  return messages.flatMap((message): ReplayMessage[] => {
    if (message.role === "tool")
      return [
        {
          role: "tool",
          callId: message.tool_call_id,
          content: String(message.content ?? ""),
          isError: looksFailed(String(message.content ?? "")),
        },
      ];
    const blocks = blocksOf(message.content);
    if (message.role === "user") return [{ role: "user", text: textOf(blocks) }];
    const calls = blocks
      .filter(
        (block): block is Extract<ContentBlock, { type: "tool_call" }> =>
          block.type === "tool_call" && typeof block.name === "string",
      )
      .map((block) => ({
        id: String(block.id ?? ""),
        name: block.name,
        args: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
      }));
    return [{ role: "assistant", text: textOf(blocks), calls }];
  });
}

/** A recorded tool result that reports a failure: a JSON object with an `error` field. */
export function looksFailed(content: string): boolean {
  try {
    const value = JSON.parse(content) as unknown;
    return !!value && typeof value === "object" && !Array.isArray(value) && "error" in value;
  } catch {
    return false;
  }
}

function captured(call: ModelCall): boolean {
  const messages = call.payload?.messages ?? [];
  return (
    messages.length >= 2 ||
    messages.some(
      (message) => message.role !== "tool" && textOf(blocksOf(message.content)).trim().length > 0,
    )
  );
}

/**
 * The run's recording from its model calls, or null when its prompts weren't
 * captured. The last call's messages hold the whole conversation: everything
 * after the first call's input is what the run did.
 */
export function readRecording(run: RunRecord, calls: readonly ModelCall[]): Recording | null {
  const points = calls.filter((call) => call.payload && captured(call));
  if (points.length === 0) return null;
  const first = points[0]!.payload!;
  const last = points[points.length - 1]!.payload!;
  const historyLength = Math.max(0, first.messages.length - 1);
  const history = toReplayMessages(first.messages.slice(0, historyLength));
  const after = toReplayMessages(last.messages.slice(historyLength));
  const results = new Map(
    after
      .filter(
        (message): message is Extract<ReplayMessage, { role: "tool" }> => message.role === "tool",
      )
      .map((message) => [message.callId, message]),
  );
  const invokes = run.steps.filter((step): step is InvokeStep => step.kind === "invoke");
  const recordedCalls: RecordedCall[] = [];
  for (const message of after) {
    if (message.role !== "assistant") continue;
    for (const call of message.calls) {
      const result = results.get(call.id);
      if (!result) continue;
      const step = invokes[recordedCalls.length];
      const failed =
        step && step.targetId === call.name ? step.outcome === "error" : result.isError;
      recordedCalls.push({ ...call, result: result.content, isError: failed || result.isError });
    }
  }
  const tools = new Map<string, ToolDef>();
  for (const point of points) {
    for (const tool of point.payload!.tools ?? []) {
      if (!tools.has(tool.name))
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        });
    }
  }
  const earlierResults = new Map(
    history
      .filter(
        (message): message is Extract<ReplayMessage, { role: "tool" }> => message.role === "tool",
      )
      .map((message) => [message.callId, message]),
  );
  const earlier = history.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.calls.flatMap((call) => {
          const result = earlierResults.get(call.id);
          return result ? [{ ...call, result: result.content, isError: result.isError }] : [];
        }),
  );
  const modelMs = points.reduce((sum, call) => sum + (call.latencyMs ?? 0), 0);
  const toolMs =
    recordedCalls.length > 0 && run.durationMs
      ? Math.max(0, (run.durationMs - modelMs) / recordedCalls.length)
      : 0;
  const inputTokens = Math.max(0, ...points.map((call) => call.inputTokens ?? 0));
  return {
    history,
    system: first.system,
    tools: [...tools.values()],
    calls: recordedCalls,
    earlier,
    model: points[0]!.model ?? first.model ?? null,
    toolMs,
    inputTokens,
  };
}

/**
 * An argument value only the conversation could have given the model: a
 * reference, an id, a code (letters and digits, no spaces). Dates and numbers
 * aren't: the model works those out from words.
 */
const IDENTIFIER = /^(?=.*\d)(?=.*[a-z])[\w./:#-]{3,}$/i;

function identifiersIn(value: unknown): string[] {
  if (typeof value === "string") return IDENTIFIER.test(value.trim()) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(identifiersIn);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(identifiersIn);
  return [];
}

/**
 * The identifiers the run's first recorded call passes that nothing the model
 * was given contains (RC-69). The replay starts at that call with the same
 * input, so a value the input never shows (a booking reference the agent read
 * from somewhere the recording doesn't keep) can't come back: the model asks
 * for it instead, and no tool path can be compared. Empty when the call is
 * grounded or takes no such value.
 */
export function ungroundedArgs(recording: Recording): string[] {
  const first = recording.calls[0];
  if (!first) return [];
  const seen = [
    recording.system ?? "",
    ...recording.history.map((message) =>
      message.role === "tool"
        ? message.content
        : message.role === "user"
          ? message.text
          : `${message.text} ${JSON.stringify(message.calls.map((call) => call.args))}`,
    ),
  ]
    .join("\n")
    .toLowerCase();
  return identifiersIn(first.args).filter((value) => !seen.includes(value.toLowerCase()));
}

/* - Applying the fix to the model's input ------------------------------------ */

export interface ReplayInput {
  system: string | undefined;
  tools: (ToolDef & { replaces?: string[] })[];
  /** Tools whose failures come back as a clear failure. */
  failClearly: ReadonlySet<string>;
  /** Crafted tools that stand in for others: their calls are answered from the sources' results. */
  merged: ReadonlyMap<string, string[]>;
  /** Whether the fix changed anything this run's model sees. */
  touched: boolean;
}

const FAILS_CLEARLY = " When it fails, it says why and whether trying again can help.";

/** The model's input with the fix applied; `change` null gives the control (the recording as it was). */
export function replayInput(
  recording: Recording,
  change: FixChange | null,
  toolDefs: ReadonlyMap<string, ToolDef>,
): ReplayInput {
  const tools: (ToolDef & { replaces?: string[] })[] = recording.tools.map((tool) => ({ ...tool }));
  const replay = change?.replay;
  if (!replay)
    return {
      system: recording.system,
      tools,
      failClearly: new Set(),
      merged: new Map(),
      touched: false,
    };
  let system = recording.system;
  let touched = false;
  const merged = new Map<string, string[]>();
  const index = () => new Map(tools.map((tool, i) => [tool.name, i]));
  for (const crafted of replay.tools) {
    const at = index();
    if (crafted.replaces.length === 0) {
      const i = at.get(crafted.name);
      if (i === undefined) continue;
      tools[i] = {
        name: crafted.name,
        description: crafted.description,
        parameters: crafted.parameters,
      };
      touched = true;
      continue;
    }
    const sources = crafted.replaces.filter((name) => at.has(name));
    if (sources.length === 0) continue;
    for (const name of sources) tools.splice(index().get(name)!, 1);
    tools.push(withReplaces(crafted));
    merged.set(crafted.name, crafted.replaces);
    touched = true;
  }
  const failClearly = new Set(
    replay.failClearly.filter(
      (name) =>
        tools.some((tool) => tool.name === name) ||
        recording.calls.some((call) => call.name === name),
    ),
  );
  for (const tool of tools)
    if (failClearly.has(tool.name)) tool.description = `${tool.description}${FAILS_CLEARLY}`;
  if (failClearly.size > 0) touched = true;
  const pre = replay.prerequisite;
  if (pre && !replay.tools.some((tool) => tool.replaces.includes(pre.tool))) {
    const tool = tools.find((item) => item.name === pre.tool);
    if (tool) {
      tool.description = `${tool.description} Run ${pre.before} first, and use what it returns.`;
      touched = true;
    }
  }
  if (replay.skill && replay.skill.steps.length > 0) {
    system = `${system ? `${system}\n\n` : ""}Skill "${replay.skill.name}": for requests like this one, run these steps in order: ${replay.skill.steps.join(", then ")}.`;
    for (const step of replay.skill.steps) {
      if (tools.some((tool) => tool.name === step)) continue;
      const def = toolDefs.get(step);
      if (def) tools.push({ ...def });
    }
    touched = true;
  }
  return { system, tools, failClearly, merged, touched };
}

function withReplaces(crafted: CraftedToolDef): ToolDef & { replaces: string[] } {
  return {
    name: crafted.name,
    description: crafted.description,
    parameters: crafted.parameters,
    replaces: crafted.replaces,
  };
}

/** A failure that passes on its own (a timeout, a rate limit, a service that is briefly down). */
const TRANSIENT =
  /time ?out|timed out|temporar|rate.?limit|too many requests|unavailable|try again later|\b(429|502|503|504)\b/i;

/**
 * A failure as a tool that fails clearly returns it: why, and whether trying
 * again can help (yes for a transient failure, no otherwise).
 */
export function clearFailure(name: string, content: string): string {
  let reason = content.trim();
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value && typeof value === "object" && "error" in value)
      reason = typeof value.error === "string" ? value.error : JSON.stringify(value.error);
  } catch {
    // Not JSON: the text is the reason.
  }
  const retryable = TRANSIENT.test(reason);
  return JSON.stringify({
    error: reason,
    tool: name,
    retryable,
    message: retryable
      ? `${name} failed: ${reason}. This is temporary: trying once more can help.`
      : `${name} failed: ${reason}. Retrying won't help with the same input: tell the user what happened, or try another way.`,
  });
}

/* - Answering the model's calls ---------------------------------------------- */

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== null && item !== undefined && item !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value ?? null;
}

/** Every argument a merged call shares with a source's recorded call has the recorded value (`sameValue`). */
function agrees(args: Record<string, unknown>, recorded: Record<string, unknown>): boolean {
  const call = canonical(args) as Record<string, unknown>;
  const source = canonical(recorded) as Record<string, unknown>;
  return Object.keys(call).every((key) => !(key in source) || sameValue(source[key], call[key]));
}

/**
 * RC-76: two canonical argument values ask for the same thing. Equal, or both
 * words with no digit where one holds the other (a place or a name written
 * another way: "tokyo" and "tokyo (hnd)"). A value with a digit (an id, a
 * date, a number, a seat) must be equal.
 */
function sameValue(recorded: unknown, given: unknown): boolean {
  if (JSON.stringify(recorded) === JSON.stringify(given)) return true;
  if (
    typeof recorded !== "string" ||
    typeof given !== "string" ||
    /\d/.test(recorded) ||
    /\d/.test(given)
  )
    return false;
  return (
    recorded.length > 0 &&
    given.length > 0 &&
    (recorded.includes(given) || given.includes(recorded))
  );
}

/**
 * RC-76: a recorded call's result answers a replayed call of the same tool
 * that passes every argument the recording passed, with the same value, and
 * maybe optional ones the recording left out (a lookup by reference that adds
 * the traveler's last name is the same lookup).
 */
export function answers(
  recorded: Pick<ReplayCall, "name" | "args">,
  call: Pick<ReplayCall, "name" | "args">,
): boolean {
  if (recorded.name !== call.name) return false;
  const given = canonical(call.args) as Record<string, unknown>;
  const wanted = canonical(recorded.args) as Record<string, unknown>;
  return Object.keys(wanted).every((key) => key in given && sameValue(wanted[key], given[key]));
}

/** Two calls match when they name the same tool with the same arguments (case, spacing, key order and empty fields aside). */
export function sameCall(
  a: Pick<ReplayCall, "name" | "args">,
  b: Pick<ReplayCall, "name" | "args">,
): boolean {
  return (
    a.name === b.name && JSON.stringify(canonical(a.args)) === JSON.stringify(canonical(b.args))
  );
}

/** `earlier`: a call the conversation already made before the run, answered as it was then (a re-read). */
type Answer = {
  content: string;
  isError: boolean;
  source: "recorded" | "composed" | "earlier" | "stand-in";
};

class BudgetSpent extends Error {
  constructor() {
    super("replay budget spent");
    this.name = "BudgetSpent";
  }
}

export interface ReplayDeps {
  models: EvalModels;
  spend: SpendMeter;
  maxSteps: number;
  /** Tool definitions seen in the project, for a skill's steps the run was never offered. */
  toolDefs: ReadonlyMap<string, ToolDef>;
  /** Shared by every run of one simulation: once the key is refused, the rest stop without calling. */
  halt?: { reason: string | null };
  /** What a run says when the meter refuses a call (the organization's daily budget, when that is what bounds it). */
  budgetNote?: string;
}

interface SideRun {
  calls: string[];
  /** The calls that weren't re-reads of a call answered before the run: what is held to the recorded path. */
  fresh: string[];
  /** Calls to a merged tool the recording couldn't answer (a stand-in did): work the replay can't vouch for. */
  unverified: number;
  outcomes: ("ok" | "error")[];
  answered: boolean;
  steps: number;
  standIns: number;
  capped: boolean;
  costUsd: number | null;
  latencyMs: number;
  /** The model that answered last (a retired one falls back mid-run). */
  model: string | null;
}

async function answerCall(
  call: ReplayCall,
  pool: RecordedCall[],
  input: ReplayInput,
  recording: Recording,
  deps: ReplayDeps,
): Promise<Answer> {
  const match = pool.find((recorded) => answers(recorded, call));
  if (match) {
    pool.splice(pool.indexOf(match), 1);
    return { content: match.result, isError: match.isError, source: "recorded" };
  }
  const sources = input.merged.get(call.name);
  if (sources) {
    const parts: Record<string, unknown> = {};
    let failed = false;
    const found = sources.flatMap((source) =>
      pool.filter((item) => item.name === source).slice(0, 1),
    );
    // RC-76: only a call that asks for what the recording did gets its results (a seat the map never offered goes to the stand-in).
    for (const recorded of found.every((item) => agrees(call.args, item.args)) ? found : []) {
      const source = recorded.name;
      pool.splice(pool.indexOf(recorded), 1);
      failed ||= recorded.isError;
      try {
        parts[source] = JSON.parse(recorded.result);
      } catch {
        parts[source] = recorded.result;
      }
    }
    if (Object.keys(parts).length > 0)
      return {
        content: JSON.stringify(failed ? { error: "a step failed", steps: parts } : parts),
        isError: failed,
        source: "composed",
      };
  }
  const reread = recording.earlier.find((earlier) => answers(earlier, call));
  if (reread) return { content: reread.result, isError: reread.isError, source: "earlier" };
  const tool = deps.models.tool;
  if (!tool)
    return {
      content: JSON.stringify({ error: "no recorded result for this call" }),
      isError: true,
      source: "stand-in",
    };
  const def = input.tools.find((item) => item.name === call.name) ?? null;
  const examples = recording.calls
    .filter((recorded) => recorded.name === call.name)
    .map((recorded) => recorded.result);
  // Room for the worst case first: other runs are calling at the same time.
  const hold = await deps.spend.reserve(tool.model, {
    inputTokens: STAND_IN_PROMPT_TOKENS + estimateTokens(def, call.args, examples),
    outputTokens: SMALL_MAX_TOKENS,
  });
  if (!hold) {
    recordBudgetRefusal(tool, "eval_gate_stand_in");
    throw new BudgetSpent();
  }
  let answer: Awaited<ReturnType<ToolStandIn["answer"]>>;
  try {
    answer = await tool.answer({ tool: def, name: call.name, args: call.args, examples });
  } catch (err) {
    deps.spend.release(hold);
    throw err;
  }
  deps.spend.settle(hold, tool.model, answer.usage);
  return { content: answer.content, isError: answer.isError, source: "stand-in" };
}

async function replaySide(
  agent: AgentModel,
  recording: Recording,
  input: ReplayInput,
  deps: ReplayDeps,
): Promise<SideRun> {
  const messages: ReplayMessage[] = [...recording.history];
  const pool = [...recording.calls];
  const side: SideRun = {
    calls: [],
    fresh: [],
    unverified: 0,
    outcomes: [],
    answered: false,
    steps: 0,
    standIns: 0,
    capped: false,
    costUsd: 0,
    latencyMs: 0,
    model: null,
  };
  const priced = recording.model && priceFor(recording.model) ? recording.model : agent.model;
  for (let step = 0; step < deps.maxSteps; step += 1) {
    // Room for the worst case first (the recorded prompt size or this one, whichever is larger, and a full answer): other runs are calling at the same time.
    const estimate = {
      inputTokens: Math.max(
        recording.inputTokens,
        estimateTokens(input.system, input.tools, messages),
      ),
      outputTokens: AGENT_MAX_TOKENS,
    };
    const hold = await deps.spend.reserve(agent.model, estimate);
    if (!hold) {
      recordBudgetRefusal(agent, "eval_gate_replay");
      throw new BudgetSpent();
    }
    let reply: AgentReply;
    try {
      reply = await agent.next({ system: input.system, tools: input.tools, messages });
    } catch (err) {
      deps.spend.release(hold);
      throw err;
    }
    deps.spend.settle(hold, reply.model, reply.usage);
    side.steps += 1;
    side.model = reply.model;
    const cost = costFor(priced, {
      input_tokens: reply.usage.inputTokens,
      output_tokens: reply.usage.outputTokens,
      cached_tokens: reply.usage.cachedTokens,
    });
    side.costUsd = side.costUsd === null || cost === null ? null : side.costUsd + cost;
    side.latencyMs += reply.latencyMs;
    messages.push({
      role: "assistant",
      text: reply.text,
      calls: reply.calls,
      ...(reply.raw ? { raw: reply.raw } : {}),
    });
    if (reply.calls.length === 0) {
      side.answered = true;
      return side;
    }
    for (const call of reply.calls) {
      const answer = await answerCall(call, pool, input, recording, deps);
      const content =
        answer.isError && input.failClearly.has(call.name)
          ? clearFailure(call.name, answer.content)
          : answer.content;
      if (answer.source === "stand-in") side.standIns += 1;
      if (answer.source === "stand-in" && input.merged.has(call.name)) side.unverified += 1;
      side.calls.push(call.name);
      if (answer.source !== "earlier") side.fresh.push(call.name);
      side.outcomes.push(answer.isError ? "error" : "ok");
      side.latencyMs += recording.toolMs;
      messages.push({ role: "tool", callId: call.id, content, isError: answer.isError });
    }
  }
  side.capped = true;
  return side;
}

/** How a side ended. */
function stopOf(side: SideRun): ReplayStop {
  return side.capped ? "step-cap" : "answered";
}

/**
 * The recorded path as the fix would run it: each run of a merged tool's
 * sources in a row becomes one call to the merged tool (as the scripted
 * stand-in plays it). Other fixes leave the path as recorded.
 */
export function intendedPath(
  recorded: readonly string[],
  merged: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < recorded.length; ) {
    const name = recorded[i]!;
    const into = [...merged].find(([, sources]) => sources.includes(name));
    if (!into) {
      out.push(name);
      i += 1;
      continue;
    }
    out.push(into[0]);
    while (i < recorded.length && into[1].includes(recorded[i]!)) i += 1;
  }
  return out;
}

/** Whether `path` makes every call of `wanted`, in order (other calls between them allowed). */
function covers(path: readonly string[], wanted: readonly string[]): boolean {
  let next = 0;
  for (const name of path) if (next < wanted.length && name === wanted[next]) next += 1;
  return next === wanted.length;
}

/** `wanted`: the path a merge's side is held to; null when the fix merges nothing. */
function viewOf(side: SideRun, wanted: readonly string[] | null): RunView {
  return {
    firstList: null,
    listKnown: false,
    searches: null,
    calls: side.calls,
    outcomes: side.outcomes,
    failed: side.outcomes.filter((outcome) => outcome === "error").length,
    // Stopped at the cap: it never answered.
    answered: side.capped ? false : side.answered,
    costUsd: side.costUsd,
    latencyMs: Math.round(side.latencyMs),
    // Work through a merged call only a stand-in answered (a guessed seat) is work the replay can't vouch for.
    ...(wanted
      ? {
          coversRecording: covers(side.calls, wanted) && side.unverified === 0,
          ...(side.unverified > 0 ? { workUnverified: true } : {}),
        }
      : {}),
  };
}

export type ReplayOutcome =
  | { ok: true; before: RunView; after: RunView; facts: ReplayFacts; note: string | null }
  /**
   * `replayFailed`: replayed, and the side without the fix made no tool calls
   * where the run made some (RC-69) or took another path (RC-76); `facts` say
   * what it did.
   */
  | {
      ok: false;
      reason: string;
      notAffected?: boolean;
      replayFailed?: boolean;
      facts?: ReplayFacts;
    };

/** Replay one run with and without the fix. */
export async function replayRun(
  run: RunRecord,
  calls: readonly ModelCall[],
  change: FixChange,
  deps: ReplayDeps,
): Promise<ReplayOutcome> {
  const recording = readRecording(run, calls);
  if (!recording) return { ok: false, reason: CANT_SIMULATE.noPrompts };
  if (!deps.models.agent) return { ok: false, reason: CANT_SIMULATE.noModel };
  if (deps.halt?.reason) return { ok: false, reason: deps.halt.reason };
  const control = replayInput(recording, null, deps.toolDefs);
  const fixed = replayInput(recording, change, deps.toolDefs);
  if (!fixed.touched)
    return {
      ok: false,
      reason: "Nothing the fix changes in what this run's model saw",
      notAffected: true,
    };
  if (ungroundedArgs(recording).length > 0) return { ok: false, reason: CANT_SIMULATE.ungrounded };
  const context = {
    recordedModel: recording.model,
    recorded: recording.calls.map(({ id, name, args }) => ({ id, name, args })),
  };
  const beforeAgent = deps.models.agent(context);
  const afterAgent = deps.models.agent(context);
  if (!beforeAgent || !afterAgent) return { ok: false, reason: CANT_SIMULATE.noModel };
  const recordedPath = recording.calls.map((call) => call.name);
  // Only a merge changes the path the work takes; other fixes are read against the recorded one.
  const intended = fixed.merged.size > 0 ? intendedPath(recordedPath, fixed.merged) : null;
  const factsOf = (before: SideRun, after: SideRun | null): ReplayFacts => {
    const model = after?.model ?? before.model ?? beforeAgent.model;
    return {
      model,
      recordedModel: recording.model && recording.model !== model ? recording.model : null,
      steps: { before: before.steps, after: after?.steps ?? 0 },
      standIns: { before: before.standIns, after: after?.standIns ?? 0 },
      controlMatchesRecording: before.fresh.join(" ") === recordedPath.join(" "),
      paths: {
        recorded: recordedPath,
        before: before.calls,
        after: after?.calls ?? [],
        ...(intended ? { intended } : {}),
      },
      capped: before.capped || (after?.capped ?? false),
      stops: { before: stopOf(before), after: after ? stopOf(after) : "not-run" },
    };
  };
  try {
    const before = await replaySide(beforeAgent, recording, control, deps);
    // The run used tools and the replay of it as it was didn't, or took another path: no baseline to read the fix against. The fix side isn't worth paying for.
    if (recording.calls.length > 0 && before.calls.length === 0)
      return {
        ok: false,
        reason: CANT_SIMULATE.noCalls,
        replayFailed: true,
        facts: factsOf(before, null),
      };
    const baseline = factsOf(before, null);
    if (!baseline.controlMatchesRecording)
      return { ok: false, reason: CANT_SIMULATE.drifted, replayFailed: true, facts: baseline };
    const after = await replaySide(afterAgent, recording, fixed, deps);
    const facts = factsOf(before, after);
    return {
      ok: true,
      before: viewOf(before, intended ? recordedPath : null),
      after: viewOf(after, intended),
      facts,
      note: replayNote(facts, beforeAgent.standIn),
    };
  } catch (err) {
    if (err instanceof BudgetSpent)
      return { ok: false, reason: deps.budgetNote ?? CANT_SIMULATE.budget };
    if (err instanceof ModelRefused) {
      logger.error({ err, turn_id: run.turnId }, "fix eval replay model key refused");
      if (deps.halt) deps.halt.reason = CANT_SIMULATE.refused;
      return { ok: false, reason: CANT_SIMULATE.refused };
    }
    logger.error({ err, turn_id: run.turnId }, "fix eval replay failed");
    return { ok: false, reason: CANT_SIMULATE.failed };
  }
}

/** What the replay had to stand in for, in plain words; null when it stood in for nothing. */
export function replayNote(facts: ReplayFacts, standInModel: boolean): string | null {
  const parts: string[] = [];
  if (standInModel) parts.push("a scripted stand-in played the model (local)");
  else if (facts.recordedModel) parts.push(`${facts.model} stood in for ${facts.recordedModel}`);
  const standIns = facts.standIns.before + facts.standIns.after;
  if (standIns > 0)
    parts.push(`${standIns} tool ${standIns === 1 ? "result" : "results"} from a stand-in`);
  if (facts.capped) parts.push("stopped at the step cap");
  return parts.length > 0 ? `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : null;
}
