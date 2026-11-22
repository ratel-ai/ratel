/**
 * How tools on this surface are named, and which of them owns which question.
 *
 * A flat surface has no discovery step. There is no `search_operations` in
 * front of these tools any more, so the name, the description and the keywords
 * *are* the routing table: an agent picks by reading them and never gets a
 * second chance to disambiguate. That makes naming a correctness concern here
 * rather than a matter of taste. A measurement made this concrete: before this
 * pass, "cost" was claimed by three tools, "tokens" by four and "queries" by
 * three, and two of the cost tools read different pipelines that can disagree.
 * An agent asking what a week cost had no way to choose, so it chose by vibe.
 *
 * ## The rules
 *
 * 1. **Routing keywords have exactly one owner.** A routing keyword names a
 *    *question* ("cost", "latency", "what should I fix"). Whoever owns it
 *    answers it; every other tool must not claim it, and should name the owner
 *    in its own description instead.
 * 2. **Family keywords may be shared.** A family keyword names a *subject*
 *    ("skill", "tool", "calibration"). An agent using one has already
 *    narrowed to a noun and will pick by verb, so `get_skill` and
 *    `update_skill` sharing "skill" costs nothing.
 * 3. **The name carries the axis, not just the noun.** When two tools read the
 *    same source and differ only by grouping, the grouping goes in the name:
 *    `get_cost_by_day` and `get_cost_by_tool`, not `get_usage_daily` and
 *    `get_tool_metrics`, which share no visible relationship at all.
 * 4. **Opposed concepts get opposed names.** `list_declared_tools` against
 *    `list_invoked_tools`; `get_span_totals` against `list_span_groups`. The
 *    pair teaches the distinction without either description having to.
 * 5. **No internal product names in tool ids.** A customer's agent has never
 *    read our navigation. `test_retrieval` says what it does; `run_playground`
 *    required knowing what we call that page. Product names stay as keywords so
 *    a human who does know still finds them.
 * 6. **Ambiguous single words become phrases.** "queries" is three different
 *    questions on this surface; "queries that retrieved a skill" is one.
 *
 * `naming.test.ts` enforces 1, 2, 5 and 6 mechanically. 3 and 4 are judgement,
 * and live here so the next person adding a tool has to read them.
 */

/**
 * The questions this surface answers, and the single tool that answers each.
 *
 * Worth reading as a list in its own right: it is the closest thing we have to
 * a statement of what an agent can ask us. A question with no owner is a gap; a
 * question with two owners is a coin flip.
 */
export const ROUTING_KEYWORDS: Readonly<Record<string, string>> = {
  // Money. One pipeline (the derived event metrics), two axes.
  cost: "get_cost_by_day",
  spend: "get_cost_by_day",
  budget: "get_cost_by_day",
  tokens: "get_cost_by_day",
  "cost per tool": "get_cost_by_tool",
  "which tool costs most": "get_cost_by_tool",

  // Speed and failure. A different pipeline (spans), and never a money question.
  latency: "get_trace_health",
  p95: "get_trace_health",
  slow: "get_trace_health",
  "error rate": "get_trace_health",

  // Slicing spans: one row of totals, or many rows grouped.
  "totals for a filter": "get_span_totals",
  "group by model": "list_span_groups",
  "which model dominates": "list_span_groups",

  // Two different facts about a tool that are constantly confused: whether the
  // runtime told us it exists, and whether anything ever called it.
  "what tools exist": "list_declared_tools",
  "tools never called": "list_invoked_tools",
  "which tools are used": "list_invoked_tools",

  // The improvement loop, in order.
  "what should i fix": "get_improvement_signals",
  "where retrieval disagreed": "list_calibration_mismatches",
  "test a change": "test_retrieval",
  "what if": "test_retrieval",

  // "Why is there nothing here." Two different answers, so two owners, each
  // qualified by its subject rather than both claiming "missing".
  "traces not arriving": "get_traces_ingest_diagnostics",

  // Limits, which are not spend.
  "plan limit": "get_quota_status",

  // Usage, read off real invocations: what runs together, and what runs next.
  "tools used together": "list_tool_cousage",
  "co-usage": "list_tool_cousage",
  "merge tools": "list_tool_crafts",
  "tool crafts": "list_tool_crafts",
  "what runs after": "list_tool_transitions",
  "next tool": "list_tool_transitions",
  "tools per intent": "list_intent_tool_usage",
  "which tool serves": "list_intent_tool_usage",

  // Queries, which meant three things before this pass.
  "queries that retrieved a skill": "list_search_queries_for_skill",
};

/**
 * Subjects, which several tools in one family may legitimately claim.
 *
 * The test allows sharing only for these. Anything else shared by three or more
 * tools is a collision that has to be resolved rather than allowlisted, which
 * is the point: adding a word here is a decision, not a default.
 */
export const FAMILY_KEYWORDS: readonly string[] = [
  "calibration",
  "catalog",
  "experiment",
  "flags",
  "job",
  "override",
  "project",
  "quota",
  "skill",
  "tool",
  "trace",
];

/**
 * Words that name a Ratel screen rather than a capability. Fine in a keyword,
 * never in a tool id: an agent connecting for the first time has read our tool
 * list and nothing else.
 */
export const INTERNAL_PRODUCT_NAMES: readonly string[] = [
  "playground",
  "bench",
  "workbench",
  "orbital",
];
