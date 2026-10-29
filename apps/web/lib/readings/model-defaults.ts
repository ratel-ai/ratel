/**
 * The model the readings write names and labels with when the operator sets none. One
 * place for the default and the environment order, so the engine's cluster names, the
 * topic names and the workflow labels never disagree about it.
 */
export const DEFAULT_LABEL_MODEL = "claude-sonnet-5";

/**
 * The naming model, by the first environment variable set among the given ones, then
 * the default. Each reading passes its own variable first (`INTENT_ENGINE_NAME_MODEL`,
 * `TOPICS_LABEL_MODEL`, `TRACE_WORKFLOW_LABEL_MODEL`), so one override can cover all.
 */
export function labelModel(
  variables: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  for (const name of variables) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return DEFAULT_LABEL_MODEL;
}
