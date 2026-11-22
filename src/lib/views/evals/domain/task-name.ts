/**
 * RC-316: how every Evals and fix screen names a task. A task's name is its
 * label (`trace_workflow_labels`); a task without one reads as "Untitled task"
 * and the first words of its most common ask. A screen never shows the raw
 * workflow id.
 */

export const UNTITLED_TASK = "Untitled task";
const ASK_WORDS = 6;
const SUITE_TASK = "Task ";

/** A task's name: its label, else "Untitled task" with the first words of its most common ask. */
export function taskDisplayName(label: string | null | undefined, asks: readonly string[]): string {
  const named = label?.trim();
  if (named) return named;
  const ask = mostCommon(asks.map((text) => text.trim().replace(/\s+/g, " ")).filter(Boolean));
  if (!ask) return UNTITLED_TASK;
  const words = ask.split(" ");
  return `${UNTITLED_TASK} · "${words.slice(0, ASK_WORDS).join(" ")}${words.length > ASK_WORDS ? "…" : ""}"`;
}

/** A task as a tag; a task the names miss reads as "Untitled task", never as its id. */
export function taskTag(
  id: string,
  names: ReadonlyMap<string, string>,
): { id: string; label: string } {
  return { id, label: names.get(id) ?? UNTITLED_TASK };
}

/** The workflow id a run's suite label names ("Task <id>"), else null. */
export function taskOfSuite(suite: string): string | null {
  return suite.startsWith(SUITE_TASK) && suite.length > SUITE_TASK.length
    ? suite.slice(SUITE_TASK.length)
    : null;
}

/** A run's suite as the screen says it: "Task <id>" reads as "Task: <name>". */
export function suiteText(suite: string, names: ReadonlyMap<string, string>): string {
  const task = taskOfSuite(suite);
  return task === null ? suite : `Task: ${taskTag(task, names).label}`;
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  for (const [value, count] of counts) if (best === null || count > counts.get(best)!) best = value;
  return best;
}
