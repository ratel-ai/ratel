import { SCORER_KINDS, type Scorer, type ScorerKind } from "@/lib/views/task-scorers/types";
import type {
  Eval,
  EvalCheck,
  EvalChecks,
  EvalFixedAnswer,
  EvalMessage,
  EvalSpecField,
  EvalTool,
  EvalTurn,
} from "./types";

/**
 * RC-297: the eval editor (D4) as data. The form holds what the person types
 * (limits and JSON as text); `parseEvalForm` turns it into the fields of an
 * eval, or says what is wrong in one sentence. Turn 1 is the recorded ask and
 * is not edited here: the replay starts from the recording. Pure.
 */

export interface EvalForm {
  name: string;
  earlier: EarlierForm[];
  /** The turns after the recorded ask. */
  turns: TurnForm[];
  tasks: string[];
  checks: Record<ScorerKind, CheckForm>;
  expectedTool: string;
  criteria: string;
  fixedAnswers: FixedAnswerForm[];
  /** RC-641: the spec fields, edited with the eval gate on. Absent, the spec stays as saved. */
  spec?: SpecForm;
}

/** RC-641: the spec as typed. `tools` is a JSON array and `context` a JSON object of text values; empty text clears the field. */
export interface SpecForm {
  systemPrompt: string;
  message: string;
  tools: string;
  context: string;
}

export type EarlierForm =
  | { role: "user" | "assistant"; text: string }
  /** `args` is JSON text; `text` is the tool's answer. */
  | { role: "tool"; tool: string; args: string; text: string };

/** `text`: the message, or the simulated person's description. */
export interface TurnForm {
  kind: EvalTurn["kind"];
  text: string;
}

/** `max`: the limit as typed (dollars for cost, seconds for run time); empty keeps the task's limit. */
export interface CheckForm {
  on: boolean;
  max: string;
}

/** `when` is JSON arguments (empty: every call); `answer` is JSON or plain text. */
export interface FixedAnswerForm {
  tool: string;
  when: string;
  answer: string;
  why: string;
}

/** The fields an edit sets. */
export interface EvalDraft {
  name: string;
  earlierMessages: EvalMessage[];
  turns: EvalTurn[];
  tasks: string[];
  checks: EvalChecks;
  expectedTool: string | null;
  criteria: string;
  fixedAnswers: EvalFixedAnswer[];
  /** RC-641: present only when the form had the spec. */
  spec?: EvalSpecDraft;
}

/** RC-641: the spec fields as an edit sets them. Null clears the field. */
export interface EvalSpecDraft {
  message: string;
  systemPrompt: string | null;
  tools: EvalTool[] | null;
  context: Record<string, string> | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const NAME_MAX = 200;
const TEXT_MAX = 4_000;
const LIST_MAX = 50;
const MESSAGE_MAX = 5_000;
const SYSTEM_PROMPT_MAX = 20_000;
const CONTEXT_VALUE_MAX = 2_000;

/** Limits in the unit the editor shows: a cost in dollars, a run time in seconds. */
const LIMIT_RULES: Partial<
  Record<
    ScorerKind,
    {
      label: string;
      integer: boolean;
      min: number;
      toStored: (value: number) => number;
      fromStored: (value: number) => string;
    }
  >
> = {
  max_self_corrections: {
    label: "Self-corrections",
    integer: true,
    min: 0,
    toStored: (v) => v,
    fromStored: String,
  },
  max_tool_calls: {
    label: "Tool calls",
    integer: true,
    min: 1,
    toStored: (v) => v,
    fromStored: String,
  },
  max_cost_usd: {
    label: "Cost",
    integer: false,
    min: Number.MIN_VALUE,
    toStored: (v) => v,
    fromStored: String,
  },
  max_latency_ms: {
    label: "Run time",
    integer: false,
    min: Number.MIN_VALUE,
    toStored: (v) => Math.round(v * 1000),
    fromStored: (v) => String(v / 1000),
  },
};

export function parseEvalForm(form: EvalForm): Parsed<EvalDraft> {
  const name = form.name.trim();
  if (!name) return fail("Give the eval a name.");
  if (name.length > NAME_MAX) return fail(`Keep the name under ${NAME_MAX} characters.`);
  if (
    [form.earlier, form.turns, form.tasks, form.fixedAnswers].some((list) => list.length > LIST_MAX)
  )
    return fail(`Keep each list under ${LIST_MAX} items.`);

  const earlierMessages: EvalMessage[] = [];
  for (const [index, message] of form.earlier.entries()) {
    const at = `Earlier message ${index + 1}`;
    if (message.role === "tool") {
      const tool = message.tool.trim();
      if (!tool) return fail(`${at}: choose the tool it called.`);
      const args = jsonObject(message.args);
      if (args === null)
        return fail(`${at}: the arguments must be a JSON object, like {"ref": "R1"}.`);
      earlierMessages.push({ role: "tool", tool, args, text: message.text.trim() });
      continue;
    }
    const text = message.text.trim();
    if (!text) return fail(`${at} is empty.`);
    if (text.length > TEXT_MAX) return fail(`${at} is too long.`);
    earlierMessages.push({ role: message.role, text });
  }

  const turns: EvalTurn[] = [];
  for (const [index, turn] of form.turns.entries()) {
    const text = turn.text.trim();
    const at = `Turn ${index + 2}`;
    if (!text)
      return fail(
        turn.kind === "person" ? `${at}: describe the simulated person.` : `${at} is empty.`,
      );
    if (text.length > TEXT_MAX) return fail(`${at} is too long.`);
    turns.push(
      turn.kind === "person" ? { kind: "person", description: text } : { kind: "message", text },
    );
  }

  const checks: EvalChecks = {};
  for (const kind of SCORER_KINDS) {
    const check = form.checks[kind];
    if (!check) continue;
    const parsed = parseCheck(kind, check);
    if (!parsed.ok) return parsed;
    if (parsed.value) checks[kind] = parsed.value;
  }
  const expectedTool = form.expectedTool.trim() || null;
  if (checks.expected_tool?.on && !expectedTool)
    return fail("Choose the expected tool, or turn that check off.");
  const criteria = form.criteria.trim();
  if (checks.judge_criteria?.on && !criteria)
    return fail("Write the criteria, or turn that check off.");
  if (criteria.length > TEXT_MAX) return fail("The criteria are too long.");

  const fixedAnswers: EvalFixedAnswer[] = [];
  for (const [index, answer] of form.fixedAnswers.entries()) {
    const at = `Fixed answer ${index + 1}`;
    const tool = answer.tool.trim();
    if (!tool) return fail(`${at}: choose the tool it answers.`);
    const when = answer.when.trim() ? jsonObject(answer.when) : {};
    if (when === null)
      return fail(
        `${at}: "When" must be JSON arguments, like {"seat": "14C"}, or empty for every call.`,
      );
    if (!answer.answer.trim()) return fail(`${at}: write the answer the tool gives.`);
    if (answer.answer.length > TEXT_MAX) return fail(`${at}: the answer is too long.`);
    const why = answer.why.trim();
    fixedAnswers.push({
      tool,
      result: jsonOrText(answer.answer.trim()),
      ...(Object.keys(when).length > 0 ? { when } : {}),
      ...(why ? { why } : {}),
    });
  }

  let spec: EvalSpecDraft | undefined;
  if (form.spec) {
    const parsed = parseSpecForm(form.spec);
    if (!parsed.ok) return parsed;
    spec = parsed.value;
  }

  const tasks = [...new Set(form.tasks.map((task) => task.trim()).filter(Boolean))].sort();
  return {
    ok: true,
    value: {
      name,
      earlierMessages,
      turns,
      tasks,
      checks,
      expectedTool,
      criteria,
      fixedAnswers,
      ...(spec ? { spec } : {}),
    },
  };
}

/** RC-641: the spec fields of the form, checked. */
export function parseSpecForm(form: SpecForm): Parsed<EvalSpecDraft> {
  const message = form.message.trim();
  if (!message) return fail("Write the message the agent gets.");
  if (message.length > MESSAGE_MAX) return fail("The message is too long.");
  const systemPrompt = form.systemPrompt.trim() || null;
  if (systemPrompt && systemPrompt.length > SYSTEM_PROMPT_MAX)
    return fail("The system prompt is too long.");
  const tools = parseTools(form.tools);
  if (!tools.ok) return tools;
  const context = parseContext(form.context);
  if (!context.ok) return context;
  return { ok: true, value: { message, systemPrompt, tools: tools.value, context: context.value } };
}

/**
 * RC-641: the spec fields an edit changes, compared with the eval as saved.
 * A field the edit leaves as it was is not in the result, so it stays `generated`.
 */
export function specChanges(
  current: Pick<Eval, "message" | "systemPrompt" | "tools" | "context">,
  spec: EvalSpecDraft,
): Partial<EvalSpecDraft> {
  const changes: Partial<EvalSpecDraft> = {};
  if (spec.message !== current.message) changes.message = spec.message;
  if (spec.systemPrompt !== (current.systemPrompt ?? null))
    changes.systemPrompt = spec.systemPrompt;
  if (!sameJson(spec.tools, current.tools ?? null)) changes.tools = spec.tools;
  if (!sameJson(spec.context, current.context ?? null)) changes.context = spec.context;
  return changes;
}

/** RC-641: a spec field a person set is no longer one a model wrote. */
export function generatedAfterEdit(
  generated: readonly EvalSpecField[],
  edited: readonly string[],
): EvalSpecField[] {
  const handSet = new Set(edited);
  return generated.filter((field) => !handSet.has(field));
}

/** The editor's starting state: the eval as saved, with each check on when the eval is held to it today. */
export function formFromEval(item: Eval, scorers: readonly Scorer[]): EvalForm {
  const held = new Map(scorers.map((scorer) => [scorer.kind, scorer]));
  const checks = Object.fromEntries(
    SCORER_KINDS.map((kind) => {
      const own = item.checks[kind];
      const rule = LIMIT_RULES[kind];
      const max = own?.on && typeof own.max === "number" && rule ? rule.fromStored(own.max) : "";
      return [kind, { on: held.has(kind), max }];
    }),
  ) as Record<ScorerKind, CheckForm>;
  return {
    name: item.name,
    earlier: item.earlierMessages.map(
      (message): EarlierForm =>
        message.role === "tool"
          ? {
              role: "tool",
              tool: message.tool ?? "",
              args:
                message.args && Object.keys(message.args).length > 0
                  ? JSON.stringify(message.args)
                  : "",
              text: message.text,
            }
          : { role: message.role, text: message.text },
    ),
    turns: item.turns.map((turn) =>
      turn.kind === "person"
        ? { kind: "person", text: turn.description }
        : { kind: "message", text: turn.text },
    ),
    tasks: [...item.tasks],
    checks,
    expectedTool:
      item.expectedTool ??
      (held.get("expected_tool") as Extract<Scorer, { kind: "expected_tool" }> | undefined)?.tool ??
      "",
    criteria:
      item.criteria ||
      ((held.get("judge_criteria") as Extract<Scorer, { kind: "judge_criteria" }> | undefined)
        ?.criteria ??
        ""),
    fixedAnswers: item.fixedAnswers.map((answer) => ({
      tool: answer.tool,
      when: answer.when && Object.keys(answer.when).length > 0 ? JSON.stringify(answer.when) : "",
      answer:
        typeof answer.result === "string" ? answer.result : JSON.stringify(answer.result, null, 2),
      why: answer.why ?? "",
    })),
    // An eval whose recorded ask was not captured has no message: its spec stays as saved, so Save still works.
    ...(item.message.trim()
      ? {
          spec: {
            systemPrompt: item.systemPrompt ?? "",
            message: item.message,
            tools: item.tools ? JSON.stringify(item.tools, null, 2) : "",
            context: item.context ? JSON.stringify(item.context, null, 2) : "",
          },
        }
      : {}),
  };
}

/** "Set a fixed answer for this tool" (G4): the step's tool, the arguments it was called with as the condition, and what it returned. */
export function fixedAnswerFromStep(step: {
  tool: string;
  args: string | null;
  result: string | null;
}): FixedAnswerForm {
  const args = step.args ? jsonObject(step.args) : null;
  return {
    tool: step.tool,
    when: args && Object.keys(args).length > 0 ? JSON.stringify(args) : "",
    answer: step.result ?? "",
    why: "",
  };
}

/** The limit's placeholder: "From the task: ≤ 12.7 s", or "No limit to set". */
export function limitHint(kind: ScorerKind, taskScorers: readonly Scorer[]): string | null {
  const rule = LIMIT_RULES[kind];
  if (!rule) return null;
  const limits = taskScorers.flatMap((scorer) =>
    scorer.kind === kind && "max" in scorer ? [scorer.max] : [],
  );
  if (limits.length === 0) return "No limit from the task";
  const strict = Math.min(...limits);
  const shown =
    kind === "max_cost_usd"
      ? `$${strict}`
      : kind === "max_latency_ms"
        ? `${strict / 1000} s`
        : String(strict);
  return `From the task: ≤ ${shown}`;
}

export function hasLimit(kind: ScorerKind): boolean {
  return kind in LIMIT_RULES;
}

function parseCheck(kind: ScorerKind, check: CheckForm): Parsed<EvalCheck | null> {
  if (!check.on) return { ok: true, value: { on: false } };
  const rule = LIMIT_RULES[kind];
  const typed = check.max.trim().replace(/^\$/, "").replace(/\s*s$/, "");
  if (!rule || !typed)
    return {
      ok: true,
      value:
        kind === "ends_well" || kind === "expected_tool" || kind === "judge_criteria"
          ? { on: true }
          : null,
    };
  const value = Number(typed);
  if (!Number.isFinite(value) || value < rule.min || (rule.integer && !Number.isInteger(value))) {
    const want = rule.integer ? `a whole number of at least ${rule.min}` : "a number above 0";
    return fail(`${rule.label}: the limit must be ${want}.`);
  }
  return { ok: true, value: { on: true, max: rule.toStored(value) } };
}

function parseTools(text: string): Parsed<EvalTool[] | null> {
  if (!text.trim()) return { ok: true, value: null };
  const shape =
    'The tools must be a JSON list, like [{"name": "find_booking", "description": "...", "parameters": {}}].';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(shape);
  }
  if (!Array.isArray(value)) return fail(shape);
  if (value.length > LIST_MAX) return fail(`Keep each list under ${LIST_MAX} items.`);
  const tools: EvalTool[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `Tool ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(shape);
    const { name, description, parameters } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return fail(`${at}: give it a name.`);
    if (description !== undefined && typeof description !== "string")
      return fail(`${at}: the description must be text.`);
    if (
      parameters !== undefined &&
      (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    )
      return fail(`${at}: the parameters must be a JSON object.`);
    tools.push({
      name: name.trim(),
      description: (description as string | undefined) ?? "",
      parameters: (parameters as Record<string, unknown> | undefined) ?? {
        type: "object",
        properties: {},
      },
    });
  }
  return { ok: true, value: tools };
}

function parseContext(text: string): Parsed<Record<string, string> | null> {
  if (!text.trim()) return { ok: true, value: null };
  const value = jsonObject(text);
  const shape = 'The context must be a JSON object of text values, like {"booking": "R1"}.';
  if (value === null) return fail(shape);
  if (Object.keys(value).length > LIST_MAX) return fail(`Keep each list under ${LIST_MAX} items.`);
  const context: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return fail(shape);
    if (entry.length > CONTEXT_VALUE_MAX) return fail(`The context value "${key}" is too long.`);
    context[key] = entry;
  }
  return { ok: true, value: Object.keys(context).length > 0 ? context : null };
}

/** Key order aside: Postgres stores JSON objects with its own key order. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

function jsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
