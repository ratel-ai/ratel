import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  estimateTokens,
  ModelRefused,
  type PersonModel,
  type ReplayMessage,
  recordBudgetRefusal,
  SMALL_MAX_TOKENS,
} from "@/lib/views/eval-gate/models";
import { type ReplayDeps, recordedScenario, replayAsRecorded } from "@/lib/views/eval-gate/replay";
import type { ReplayTranscriptStep } from "@/lib/views/eval-gate/types";
import { recordFromConversation } from "@/lib/views/scorers/adapters/run-record";
import { scoreRecord } from "@/lib/views/scorers/domain/engine";
import type { ScoreResult, Scorer as UserScorer } from "@/lib/views/scorers/domain/types";
import type { JudgePort, ScorerPorts } from "@/lib/views/scorers/ports";
import type { Scorer } from "@/lib/views/task-scorers/types";
import { verdictsOf } from "./domain/scoring";
import {
  type Eval,
  type EvalAttempts,
  type EvalToolAnswer,
  type EvalTranscript,
  type EvalTurn,
  type EvalTurnResult,
  type EvalVerdict,
  SIMULATED_PERSON_ATTEMPTS,
} from "./domain/types";
import type { EvalReplay } from "./job";
import { evalReplayExtras } from "./replay-extras";

/**
 * RC-296: an eval replayed turn by turn. The first turn is the recorded ask;
 * each later turn is a fixed message or one a simulated person writes from
 * its description and the conversation so far. The engine replays one turn
 * at a time with the growing conversation, and each turn is scored on its
 * own work: the eval passes when every turn does. An eval with a simulated
 * person runs `SIMULATED_PERSON_ATTEMPTS` times (Q4) and reports how many
 * passed; it passes when all do. The person's calls go through the same
 * spend meter as the replay, reserved first.
 */

export interface EvalTurnsDeps {
  /** The replay's deps: one spend meter for the agent, the tool stand-in and the person. */
  replay: ReplayDeps;
  person: PersonModel | null;
  scorers: readonly Scorer[];
  /** RC-613: judges the task criteria on each turn's conversation. Absent leaves them unjudged. */
  criteriaJudge?: JudgePort | null;
  /** RC-613: the user's own scorers for this eval (task and suite, after its switches), read once on the whole run. */
  user?: { scorers: readonly UserScorer[]; ports: ScorerPorts };
}

export interface EvalTurnsResult {
  passed: boolean | null;
  /** The verdicts of the turn that decided: the first that failed, else the last. */
  verdicts: EvalVerdict[];
  durationMs: number | null;
  costUsd: number | null;
  toolCalls: number | null;
  toolAnswers: EvalToolAnswer[];
  transcript: EvalTranscript | null;
  turns: EvalTurnResult[] | null;
  attempts: EvalAttempts | null;
  error: string | null;
  /** RC-613: the user scorers' readings of the shown run. */
  scores?: ScoreResult[];
}

/** The person's own instructions, on top of the description and conversation, for its estimate. */
const PERSON_PROMPT_TOKENS = 200;
const NO_PERSON = "No model can play the simulated person, so this eval can't run.";

type Item = Pick<Eval, "earlierMessages" | "fixedAnswers" | "turns" | "opening">;

export async function runEvalTurns(
  item: Item,
  replay: EvalReplay,
  deps: EvalTurnsDeps,
): Promise<EvalTurnsResult> {
  const simulated = item.turns.some((turn) => turn.kind === "person");
  const total = simulated ? SIMULATED_PERSON_ATTEMPTS : 1;
  const runs: EvalTurnsResult[] = [];
  for (let attempt = 0; attempt < total; attempt += 1) {
    const run = await runOnce(item, replay, deps);
    if (run.error) return { ...run, attempts: simulated ? attemptsOf(runs) : null };
    runs.push(run);
  }
  // Show the first run that failed, else the last.
  const shown = runs.find((run) => run.passed === false) ?? runs.at(-1)!;
  return {
    ...shown,
    passed: allPassed(runs.map((run) => run.passed)),
    attempts: simulated ? attemptsOf(runs) : null,
  };
}

/** One pass through every turn. */
async function runOnce(
  item: Item,
  replay: EvalReplay,
  deps: EvalTurnsDeps,
): Promise<EvalTurnsResult> {
  // RC-654: the opening plays in the first turn only; later turns get it back in `after`.
  const { opening, ...extras } = evalReplayExtras(item);
  const keepText = deps.replay.trace?.keepText ?? false;
  // RC-609: the scenario the replay runs (the eval's message when it has a spec and no recording).
  const recorded =
    (deps.replay.scenario ?? recordedScenario)({ run: replay.run, calls: replay.calls })?.history ??
    [];
  const turns: (EvalTurn | null)[] = [null, ...item.turns];
  const results: EvalTurnResult[] = [];
  const toolAnswers: EvalToolAnswer[] = [];
  const steps: ReplayTranscriptStep[] = [];
  let toolsOffered: string[] = [];
  let durationMs = 0;
  let costUsd: number | null = 0;
  let after: ReplayMessage[] = [];
  const failed = (error: string): EvalTurnsResult => ({
    passed: null,
    verdicts: [],
    durationMs: null,
    costUsd: null,
    toolCalls: null,
    toolAnswers,
    transcript: keepText && steps.length > 0 ? { toolsOffered, steps } : null,
    turns: item.turns.length > 0 ? results : null,
    attempts: null,
    error,
  });
  for (const turn of turns) {
    let said: string;
    if (!turn) said = lastUserText(recorded);
    else if (turn.kind === "message") said = turn.text;
    else {
      const written = await personSays(
        turn.description,
        [...(extras.history ?? []), ...recorded, ...after],
        deps,
      );
      if (!written.ok) return failed(written.error);
      said = written.text;
    }
    if (turn) after = [...after, { role: "user", text: said }];
    const outcome = await replayAsRecorded(replay.run, replay.calls, deps.replay, {
      ...extras,
      after,
      conversation: true,
      ...(!turn && opening ? { opening } : {}),
    });
    const answers = (outcome.trace?.answers ?? []).map(({ tool, source, reason, ms, why }) => ({
      tool,
      source,
      reason,
      ms,
      ...(why ? { why } : {}),
    }));
    toolAnswers.push(...answers);
    if (outcome.trace?.transcript) {
      steps.push(...outcome.trace.transcript);
      toolsOffered = outcome.trace.toolsOffered;
    }
    if (!outcome.ok) return failed(outcome.reason);
    const criteriaPass = await judgedCriteria(
      [...recorded, ...after, ...(outcome.messages ?? [])],
      outcome.view,
      deps,
    );
    const { verdicts, passed } = verdictsOf(
      criteriaPass === undefined ? outcome.view : { ...outcome.view, criteriaPass },
      deps.scorers,
    );
    results.push({
      simulated: turn?.kind === "person",
      message: keepText ? said : null,
      passed,
      verdicts,
      answers: answers.length,
    });
    durationMs += outcome.view.latencyMs ?? 0;
    costUsd =
      costUsd === null || outcome.view.costUsd === null || outcome.view.costUsd === undefined
        ? null
        : costUsd + outcome.view.costUsd;
    after = [...after, ...(outcome.messages ?? [])];
  }
  const decided = results.find((turn) => turn.passed === false) ?? results.at(-1)!;
  const scores =
    deps.user && deps.user.scorers.length > 0
      ? await scoreRecord(
          recordFromConversation([...recorded, ...after], { latencyMs: durationMs, costUsd }),
          deps.user.scorers,
          deps.user.ports,
        )
      : undefined;
  const userPassed = scores
    ? allPassed(scores.map((score) => (score.status === "skip" ? null : score.status === "pass")))
    : null;
  return {
    ...(scores ? { scores } : {}),
    passed: allPassed([...results.map((turn) => turn.passed), userPassed]),
    verdicts: decided.verdicts,
    durationMs,
    costUsd,
    toolCalls: toolAnswers.length,
    toolAnswers,
    transcript: keepText ? { toolsOffered, steps } : null,
    turns: item.turns.length > 0 ? results : null,
    attempts: null,
    error: null,
  };
}

/**
 * RC-613: the task criteria's verdict on one turn, from the criteria judge.
 * Undefined when the eval has no criteria or no judge, so the verdict stays
 * as the replay left it.
 */
async function judgedCriteria(
  messages: readonly ReplayMessage[],
  view: { latencyMs?: number | null; costUsd?: number | null },
  deps: EvalTurnsDeps,
): Promise<boolean | null | undefined> {
  const criteria = deps.scorers.find((scorer) => scorer.kind === "judge_criteria");
  if (!criteria || criteria.kind !== "judge_criteria" || !deps.criteriaJudge) return undefined;
  if (deps.replay.halt?.reason) return null;
  const record = recordFromConversation(messages, {
    latencyMs: view.latencyMs ?? null,
    costUsd: view.costUsd ?? null,
  });
  const [result] = await scoreRecord(
    record,
    [
      {
        id: "task-criteria",
        name: "Task criteria",
        scope: "task",
        taskId: null,
        enabled: true,
        goodThreshold: 0.5,
        version: 1,
        kind: "judge",
        config: { criteria: criteria.criteria },
      },
    ],
    { judge: deps.criteriaJudge },
  );
  return result!.status === "skip" ? null : result!.status === "pass";
}

/** The simulated person's next message, its worst case reserved on the replay's meter first. */
async function personSays(
  description: string,
  messages: readonly ReplayMessage[],
  deps: EvalTurnsDeps,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const person = deps.person;
  if (!person) return { ok: false, error: NO_PERSON };
  if (deps.replay.halt?.reason) return { ok: false, error: deps.replay.halt.reason };
  const { spend } = deps.replay;
  const hold = await spend.reserve(person.model, {
    inputTokens: PERSON_PROMPT_TOKENS + estimateTokens(description, messages),
    outputTokens: SMALL_MAX_TOKENS,
  });
  if (!hold) {
    recordBudgetRefusal(person, "eval_gate_stand_in");
    return { ok: false, error: deps.replay.budgetNote ?? CANT_SIMULATE.budget };
  }
  try {
    const written = await person.write({ description, messages });
    spend.settle(hold, person.model, written.usage);
    return { ok: true, text: written.text };
  } catch (err) {
    spend.release(hold);
    if (!(err instanceof ModelRefused)) throw err;
    if (deps.replay.halt) deps.replay.halt.reason = CANT_SIMULATE.refused;
    return { ok: false, error: CANT_SIMULATE.refused };
  }
}

/** Fails when one fails; null when none was scored. */
function allPassed(results: readonly (boolean | null)[]): boolean | null {
  if (results.includes(false)) return false;
  return results.includes(true) ? true : null;
}

function attemptsOf(runs: readonly EvalTurnsResult[]): EvalAttempts {
  return { passed: runs.filter((run) => run.passed === true).length, total: runs.length };
}

function lastUserText(messages: readonly ReplayMessage[]): string {
  return (
    [...messages]
      .reverse()
      .find(
        (message): message is Extract<ReplayMessage, { role: "user" }> => message.role === "user",
      )?.text ?? ""
  );
}
