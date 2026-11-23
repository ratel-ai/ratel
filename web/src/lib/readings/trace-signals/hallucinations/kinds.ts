/**
 * The closed vocabulary of hallucination detection: what the agent made up,
 * as the rules read it from a trace (`detect.ts`). Three groups, by what was
 * wrong:
 *   tool        the tool it asked for (one that does not exist, or a wrong
 *               name the runtime sent somewhere else);
 *   input       what it sent (a record that does not exist, a value that is
 *               not allowed);
 *   completion  what it said about its own work ("done" after the call that
 *               would have done it failed, or "done" the person's next
 *               message says was not).
 * A finding stores a kind and ids, never message words.
 */

export const HALLUCINATION_GROUPS = ["tool", "input", "completion"] as const;
export type HallucinationGroup = (typeof HALLUCINATION_GROUPS)[number];

export const HALLUCINATION_KINDS = [
  "unknown_tool",
  "tool_rerouted",
  "tool_action_changed",
  "unknown_reference",
  "value_not_allowed",
  "claimed_done_after_failure",
  "done_but_person_says_not",
] as const;
export type HallucinationKind = (typeof HALLUCINATION_KINDS)[number];

export const GROUP_OF: Record<HallucinationKind, HallucinationGroup> = {
  unknown_tool: "tool",
  tool_rerouted: "tool",
  tool_action_changed: "tool",
  unknown_reference: "input",
  value_not_allowed: "input",
  claimed_done_after_failure: "completion",
  done_but_person_says_not: "completion",
};

/** What a finding rests on, as a closed id: which shape of the trace the rule matched. */
export const HALLUCINATION_EVIDENCE = [
  "error_names_tool",
  "result_no_such_tool",
  "requested_differs",
  "entity_not_found",
  "no_entity_matched",
  "lists_allowed_values",
  "claim_after_failure",
  "person_says_not_done",
] as const;
export type HallucinationEvidence = (typeof HALLUCINATION_EVIDENCE)[number];

/** Bump when a rule changes what it finds: a row of an older version is rewritten by the next reading. */
export const HALLUCINATION_RULE_VERSION = 2;

export const GROUP_LABEL: Record<HallucinationGroup, string> = {
  tool: "Tool hallucinations",
  input: "Input hallucinations",
  completion: "Completion hallucinations",
};

export const GROUP_MEANING: Record<HallucinationGroup, string> = {
  tool: "The agent asked for a tool that does not exist, or by a name that is not the tool's.",
  input:
    "The agent sent something that does not exist: a record no call returned, or a value the tool does not take.",
  completion: "The agent said its work was done when the trace shows it was not.",
};

export const KIND_LABEL: Record<HallucinationKind, string> = {
  unknown_tool: "Called a tool that doesn't exist",
  tool_rerouted: "Wrong tool name, rerouted",
  tool_action_changed: "Rerouted to a different action",
  unknown_reference: "Referred to something that doesn't exist",
  value_not_allowed: "Used a value that isn't allowed",
  claimed_done_after_failure: "Said it was done, but it wasn't",
  done_but_person_says_not: "Said it was done; the person says it wasn't",
};

export const KIND_MEANING: Record<HallucinationKind, string> = {
  unknown_tool:
    "The agent called a tool the catalog does not have, and the call failed because no such tool exists.",
  tool_rerouted:
    "The agent asked for a tool by a name that is not in the catalog. The runtime ran another tool that does the same kind of thing.",
  tool_action_changed:
    "The agent asked for a tool by a name that is not in the catalog, and the tool that ran does something else: a read became a write, an update became a create.",
  unknown_reference:
    "The call named a record that does not exist: the tool answered that it was not found, with no hint that access was the reason.",
  value_not_allowed:
    "The call sent a value the tool does not take, and the tool answered with the values it does.",
  claimed_done_after_failure:
    "The reply says the work is done, but the call that would have done it failed and nothing after it made up for it.",
  done_but_person_says_not:
    "The agent's reply says the work is done, and the person's next message says it was not. The claim is read from the reply by rules; the person's answer by a model, where the project sends people's messages.",
};

export const kindOf = (value: string): HallucinationKind | null =>
  HALLUCINATION_KINDS.find((known) => known === value) ?? null;
export const groupOf = (value: string): HallucinationGroup | null =>
  HALLUCINATION_GROUPS.find((known) => known === value) ?? null;
