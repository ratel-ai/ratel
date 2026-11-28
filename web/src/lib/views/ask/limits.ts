/**
 * The numbers of Ask in words (decisions `ask-limits` and `ask-defaults`), in one place. A draft
 * that passes one of the three limits is not made: the result says which limit and when it resets.
 */

export const ASK_LIMITS = {
  /** Drafts one organization may ask for in one UTC day. */
  draftsPerOrgPerDay: 200,
  /** Drafts one person may ask for in one minute. */
  draftsPerPersonPerMinute: 10,
  /** What the drafts of one organization may spend on the model in one UTC day, in USD. */
  usdPerOrgPerDay: 5,
} as const;

/** The most widgets one draft gives, by what the person asked for. */
export const ASK_MAX_WIDGETS = { dashboard: 8, widget: 1 } as const;

/** The most characters of the person's words. */
export const ASK_MAX_WORDS = 500;

/** The earlier asks of the project the request holds, newest first. */
export const ASK_EARLIER_ASKS = 10;

/** The widgets of the other dashboards the request of a new dashboard holds, at most. */
export const ASK_OTHER_WIDGETS = 30;

/** The model of every draft: the newest Claude Haiku the backend serves. */
export const ASK_MODEL = "claude-haiku-5-5";

/** The feature name of the draft's model calls, as `model_call` logs them. */
export const ASK_FEATURE = "ask_draft_widgets";

/** The most tokens one answer of the model may have. */
export const ASK_MAX_TOKENS = 4_096;

/** Model calls of one draft at most: the first answer, and one repair round. */
export const ASK_MAX_CALLS = 2;
