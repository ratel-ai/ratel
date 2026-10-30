/**
 * The model the readings write names and labels with when the operator sets none. The
 * engine's cluster names read it here; the topic names and the workflow labels (step 9)
 * import the same constant, so the three never disagree about the default. Each reading
 * keeps its own environment order (`INTENT_ENGINE_NAME_MODEL`, `TOPICS_LABEL_MODEL`,
 * `TRACE_WORKFLOW_LABEL_MODEL`) as upstream does.
 */
export const DEFAULT_LABEL_MODEL = "claude-sonnet-5";
