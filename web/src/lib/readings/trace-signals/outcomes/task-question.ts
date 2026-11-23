import type {
  OutcomeAsk,
  OutcomeQuestion,
  OutcomeVerdict,
} from "@/lib/readings/trace-signals/outcomes/ask";
import { UNKNOWN_ANSWER } from "@/lib/readings/trace-signals/outcomes/ask";
import {
  clip,
  OUTCOME_MAX_MESSAGE_CHARS,
  OUTCOME_MAX_REPLY_CHARS,
} from "@/lib/readings/trace-signals/outcomes/question-content";
import { describeCalls, type QuestionCall } from "@/lib/readings/trace-signals/outcomes/questions";
import {
  TASK_ANSWERS,
  type TaskAnswer,
  type TaskVerdict,
} from "@/lib/readings/trace-signals/outcomes/tasks";

/**
 * The task question: one closed question about a whole task (`tasks.ts`),
 * asked when the task has a goal in words, the person's request or the
 * agent's own tool search. "Did the work achieve the goal?" The answer is one
 * input to the task's result; what the task came to is decided in code.
 *
 * The content is one template for every project, built from what it sends:
 * the goal, each exchange of the task (a later message from the person, what
 * the agent did, its reply when captured) and the person's message after the
 * task. Repeated calls are folded ("update_task (ok) ×6").
 *
 * PRIVACY: the contents are built in memory, sent and dropped. Only the
 * closed answer is kept.
 */

const DESCRIPTIONS: Record<TaskAnswer, string> = {
  achieved: "The work did what the goal asked for.",
  partly: "Part of the goal was done and part was not.",
  not_achieved: "The work did not do what the goal asked for, or did something else instead.",
  cant_tell: "There is not enough here to tell whether the goal was achieved.",
};

export const TASK_QUESTION: OutcomeQuestion = {
  id: "task_done",
  version: 1,
  kind: "choice",
  instructions:
    "Below is a goal and the work an AI agent did for it. Did the work achieve the goal?",
  options: TASK_ANSWERS.map((option) => ({ option, description: DESCRIPTIONS[option] })),
  mayReason: true,
};

const MAX_EXCHANGES = 8;
const MAX_QUERIES = 6;
const MAX_QUERY_CHARS = 200;

/** One exchange of a task: the person's later message (none for the first), what the agent did, its reply. */
export interface TaskExchange {
  message: string | null;
  calls: readonly QuestionCall[];
  reply: string | null;
}

/** A task as the question reads it. */
export interface TaskQuestionInput {
  taskId: string;
  goal: { source: "request"; text: string } | { source: "search"; queries: readonly string[] };
  exchanges: readonly TaskExchange[];
  /** The person's next message after the task; null when there is none. */
  next: string | null;
}

/** Repeated calls in a row, folded: `update_task (ok) ×6`. */
export function foldCalls(calls: readonly QuestionCall[]): string {
  if (calls.length === 0) return "nothing";
  const runs: Array<{ call: QuestionCall; n: number }> = [];
  for (const call of calls) {
    const last = runs.at(-1);
    if (
      last &&
      last.call.tool === call.tool &&
      last.call.outcome === call.outcome &&
      (last.call.error ?? null) === (call.error ?? null)
    )
      last.n += 1;
    else runs.push({ call, n: 1 });
  }
  return runs.map(({ call, n }) => `${describeCalls([call])}${n > 1 ? ` ×${n}` : ""}`).join("; ");
}

/** The question's content for one task. */
export function taskContent(task: TaskQuestionInput): string {
  const lines =
    task.goal.source === "request"
      ? [`Goal, as the person asked: ${clip(task.goal.text, OUTCOME_MAX_MESSAGE_CHARS)}`]
      : [
          "Goal, as the agent searched its tools for it:",
          ...task.goal.queries
            .slice(0, MAX_QUERIES)
            .map((query, i) => `${i + 1}. ${clip(query, MAX_QUERY_CHARS)}`),
        ];
  const exchanges =
    task.exchanges.length > MAX_EXCHANGES
      ? [task.exchanges[0]!, ...task.exchanges.slice(-(MAX_EXCHANGES - 1))]
      : task.exchanges;
  for (const exchange of exchanges) {
    if (exchange.message)
      lines.push(`The person then said: ${clip(exchange.message, OUTCOME_MAX_MESSAGE_CHARS)}`);
    lines.push(`The agent did: ${foldCalls(exchange.calls)}`);
    if (exchange.reply)
      lines.push(`The agent replied: ${clip(exchange.reply, OUTCOME_MAX_REPLY_CHARS)}`);
  }
  if (task.next)
    lines.push(`After that the person said: ${clip(task.next, OUTCOME_MAX_MESSAGE_CHARS)}`);
  return lines.join("\n");
}

export const taskAskKey = (taskId: string): string => `${taskId}:${TASK_QUESTION.id}`;

/** The task question about one task. */
export function taskAsk(task: TaskQuestionInput): OutcomeAsk {
  return { key: taskAskKey(task.taskId), question: TASK_QUESTION, content: taskContent(task) };
}

/** A cached or fresh answer read back as a task verdict; null when the task was not answered. */
export function taskVerdictOf(verdict: OutcomeVerdict | undefined): TaskVerdict | null {
  if (!verdict) return null;
  const answer = TASK_ANSWERS.find((known) => known === verdict.answer);
  return { answer: answer ?? (UNKNOWN_ANSWER as "unknown"), probability: verdict.probability };
}
