/**
 * A real analyst response, captured once and replayed by the local stand-in.
 *
 * The stand-in used to append `| Use cases: <the queries it lost>` to whatever the
 * description already said. That exercised the plumbing but not the surface: every
 * proposal had the same shape, the same length and the same non-argument, so the
 * layout was never tested against text that reasons, cites siblings by name, and
 * runs to three lines. Anyone judging the design on it was judging a placeholder.
 *
 * So this is the genuine article: one real `claude-sonnet-5` call against the
 * committed `acme-mcp-demo` seed (`scripts/seed-quality-shadow.mts`), recorded
 * verbatim. It is Acme-SHAPED, not Acme: the seed is fixture data in this
 * repo, so no customer's catalog or end-user queries are baked in here.
 *
 * It is still a fixture. Replaying it is not analysis, every run made with it is
 * stored `mocked = true`, and the surface says so. See `lib/match-quality/mock.ts`.
 */

/** One captured rewrite, keyed by the entry it was written for. */
export interface CapturedProposal {
  searchableDescription: string;
  /** One plain sentence: what changed. Printed under the new text. */
  rationale: string;
  /** The full audit, behind a disclosure. This is the captured model prose. */
  details: string;
  expectedEffect: string;
}

/** The captured run-level read. */
export const CAPTURED_DIAGNOSIS =
  "The catalog's descriptions are almost all single generic sentences that restate the tool name and give the ranker nothing to distinguish near-synonym tools (search vs. search-with-comments vs. filter vs. count vs. status-list; unlink-task-relationship vs. unlink-PR; create-task vs. duplicate-check; document-content vs. planning-bundle). Recall is fine (the right tool is usually somewhere in the list) but ranking is bad because several thin descriptions overlap on the same keywords, so the fused score can't separate them and a broader 'bundle' tool often steals first place from the narrower, correct one. Fixing this means adding one clause per entry that names what makes it different from its closest sibling, plus 2-3 realistic user phrasings, not adding more generic keywords.";

/** Captured rewrites, by entry id. Entries outside this set fall back to a template. */
export const CAPTURED_PROPOSALS: Readonly<Record<string, CapturedProposal>> = {
  search_tasks: {
    rationale:
      "Said this is the general keyword search, not the time-windowed or comment-inclusive one.",
    searchableDescription:
      "Full-text keyword search across all tasks by title or description, returning matching task records. Use when the user wants to find or look up tasks by content or keyword across the whole project, as opposed to filtering by status/comments or browsing a summary bundle. | Use cases: search all existing tasks for a topic; find a task by keyword; look up a task by its ID or title.",
    details:
      "search_tasks was never returned in 8 of 29 cases and ranked below other tools in 13 more, losing to search_tasks_by_time, search_tasks_with_comments, and get_project_brain (e.g. 'search all existing tasks for resynced source documents' [invoked], 'look up task UI-168 with its comments' [invoked]). The current one-line description gives no signal that this is the general keyword-search tool distinct from time-windowed search or comment-inclusive search or the project-brain bundle.",
    expectedEffect:
      "search_tasks should rank first more often on plain keyword/lookup queries instead of losing to search_tasks_by_time or get_project_brain.",
  },
  search_tasks_with_comments: {
    rationale:
      "Said it returns tasks together with their comments, which the old line never made clear.",
    searchableDescription:
      "Search tasks and return each matching task together with its comments in one call. Use when the user wants tasks plus their discussion/comments, not just a bare task list or status list. | Use cases: find a task and see its comments; list tasks with status and comments; look up a task by ID along with its comments.",
    details:
      "This entry was correct 16 times but never ranked first, losing to list_tasks_by_status ('list tasks in a project with status and comments' [invoked]) and to plain search_tasks on comment-inclusive lookups. The description 'Search tasks and return their comments' is too thin to compete against list_tasks_by_status's clearer status-matching text.",
    expectedEffect:
      "Queries that explicitly ask for tasks plus comments/status should rank this tool ahead of list_tasks_by_status and plain search_tasks.",
  },
  filter_tasks: {
    rationale: "Named the structured filters it takes, so it stops losing to plain search.",
    searchableDescription:
      "Filter tasks by two or more criteria (status, assignee, project, tag, etc.) and return the matching list of tasks. Use when the user wants to see or list the tasks that match certain conditions, not just a count of them. | Use cases: list tasks in a project; list tasks assigned to someone; filter tasks by status and priority.",
    details:
      "filter_tasks was never returned at all for 8 of its 8 correct cases, losing outright to count_tasks on 'list tasks in a project' [invoked]. count_tasks already signals 'Returns a number,' but filter_tasks's description doesn't say it returns the actual list, so BM25/dense matching can't tell them apart on generic 'list tasks' phrasing.",
    expectedEffect:
      "Generic 'list/show tasks matching X' queries should now favor filter_tasks over count_tasks.",
  },
  create_task: {
    rationale: "Said it creates one task, and pointed duplicate checks and batches elsewhere.",
    searchableDescription:
      "Create a single new task in a project, optionally overriding or skipping the duplicate check. Use when the user wants to add one new task, including cases where they explicitly want to force creation despite a possible duplicate. | Use cases: create a task; add a new task to a project; create task and skip duplicate check.",
    details:
      "create_task was correct in all 15 of its cases but never ranked first, losing to check_task_duplicates on 'create task force override skip duplicate check' [invoked]. The current description has no language about duplicate overrides, so a query mentioning duplicates naturally biases toward check_task_duplicates.",
    expectedEffect:
      "Creation requests that mention overriding/skipping duplicate checks should rank create_task first instead of check_task_duplicates.",
  },
  delete_task_relationship: {
    rationale: "Spelled out that this unlinks task-to-task edges, not pull requests.",
    searchableDescription:
      "Remove a link, dependency, or relationship between two tasks (task-to-task only, not a pull request). Use when the user wants to unlink or disconnect two tasks from each other. | Use cases: unlink tasks; remove a task dependency; delete the relationship between two tasks.",
    details:
      "delete_task_relationship was correct in all 15 cases but never ranked first, losing to unlink_pr_from_task on the query 'unlink tasks' [invoked]. Both entries share the word 'unlink' with no distinguishing language about task-vs-PR targets.",
    expectedEffect:
      "Plain 'unlink tasks' / 'remove task dependency' queries should rank delete_task_relationship first instead of unlink_pr_from_task.",
  },
  unlink_pr_from_task: {
    rationale: "Spelled out that this unlinks a pull request, not a task relationship.",
    searchableDescription:
      "Detach or unlink a pull request (PR) from a task, removing the PR-task association specifically, not a task-to-task dependency. Use when the user mentions a pull request, PR, or code change being linked to a task. | Use cases: unlink a PR from a task; remove a pull request association; detach code change from task.",
    details:
      "This is the partner side of the 'unlink tasks' collision: unlink_pr_from_task wrongly ranked first for a query about unlinking tasks generally [invoked evidence under delete_task_relationship]. Naming that it is specifically for PR associations, not task-task links, should stop it from winning generic unlink queries.",
    expectedEffect:
      "unlink_pr_from_task should stop outranking delete_task_relationship on generic 'unlink tasks' queries, only winning when PR/pull request is mentioned.",
  },
  get_document_content: {
    rationale: "Said it returns one document's text, rather than the whole project bundle.",
    searchableDescription:
      "Retrieve the full text content of one specific document by its ID or title. Use when the user wants to read or open a document's actual content, not a summary bundle or planning overview. | Use cases: get document by ID; read a document's content; open a specific document.",
    details:
      "get_document_content was correct in all 9 of its cases but never ranked first, losing to get_daily_planning_context on 'get document 1HHcTFiN eager durable chroma plan' [invoked], where the baseline correctly ranked it first. The description gives no cue that this is for a single named/ID'd document versus a bundled planning overview.",
    expectedEffect:
      "Queries naming or ID-referencing a specific document should rank get_document_content ahead of get_daily_planning_context.",
  },
};
