/**
 * The demo project's tool catalog: what each tool IS, not just how often it ran.
 *
 * The demo agent is a coding agent that also keeps its project tracker in step,
 * so the catalog is the shape a real one has: a handful of local dev tools plus
 * a large, densely-named integration surface where several entries are
 * plausible answers to the same question. That density is the point. A catalog
 * of five well-separated tools makes retrieval look easy; the interesting cases
 * ("find the task for this branch" matching four different lookup operations)
 * only appear once the surface is big enough to collide with itself.
 *
 * Descriptions are the whole reason this file exists. Telemetry recovers a tool
 * NAME, and a name alone is not what BM25 or an embedding matches on, so a
 * catalog without definitions is a catalog where no tool can ever be retrieved.
 *
 * `weight` is relative call volume, used to split a run's tool-token budget.
 * A tool with no `description` is deliberately left undefined: "observed but
 * never synced" is a real state, and it is exactly the state that explains why
 * a tool never surfaces.
 */

export interface DemoTool {
  name: string;
  /** Omitted for tools telemetry has seen but no sync has ever described. */
  description?: string;
  /**
   * What the runtime registered as this tool's SEARCHABLE description — the
   * text a prompt is matched against, as opposed to `description`, which is
   * what the agent is handed back.
   *
   * Omitted means the runtime copied the description across, which is what
   * ingest does by default and therefore what most entries look like. The two
   * tools that set it are the point of the field: without at least one demo
   * entry where the two texts genuinely differ, the product's central catalog
   * behavior is invisible on a fresh account and untestable by hand locally.
   */
  searchableDescription?: string;
  weight: number;
}

export const DEMO_TOOLS: readonly DemoTool[] = [
  // Local development tools. The skills catalog references these by name.
  {
    name: "github_api",
    description:
      "Read and write GitHub resources for a repository: pull requests, reviews, issues, commits, branches, and release tags.",
    searchableDescription:
      "open a pull request, review code, check CI on a branch, cut a release tag",
    weight: 34,
  },
  {
    name: "ripgrep",
    description:
      "Search a working tree for a regular expression and return every match with its file path, line number, and surrounding context lines.",
    searchableDescription:
      "find where something is defined, grep the codebase, search for a string",
    weight: 26,
  },
  {
    name: "test_runner",
    description:
      "Run a project's test suite, or a single file or test name, and return pass and fail counts together with the output of each failure.",
    searchableDescription: "run the tests, check whether tests pass, reproduce a failing test",
    weight: 18,
  },
  {
    name: "stacktrace_parser",
    description:
      "Parse an exception stack trace into ordered frames with file, line, and symbol, and identify the first frame that belongs to project code.",
    searchableDescription:
      "debug a crash, read an exception, find which line threw, blame a stack trace",
    weight: 13,
  },
  {
    name: "flaky_deploy_api",
    description:
      "Trigger a deployment to an environment and poll the rollout until it settles. Returns 503s and connection timeouts under load.",
    // Deliberately different from the description: nobody types "poll the
    // rollout until it settles", they type "ship it to staging". This is the
    // entry that shows why the two texts are separate fields.
    searchableDescription:
      "deploy, ship a release, push to staging or production, roll out a new version",
    weight: 9,
  },

  // The project-tracker integration: many operations, deliberately overlapping.
  {
    name: "tracker_search_operations",
    description:
      "Find the right project-tracker operation for a natural-language intent. Returns candidate operation ids with confidence scores and their required parameters.",
    searchableDescription:
      "what can the project tracker do, find the right operation for what I want",
    weight: 22,
  },
  {
    name: "tracker_execute_operation",
    description:
      "Run a project-tracker operation by id with validated parameters. Returns the operation result, or a validation error carrying the full input schema.",
    weight: 30,
  },
  {
    name: "tracker_whoami",
    description:
      "Return the caller's project-tracker identity: workspace id and name, member id, and member display name.",
    weight: 6,
  },
  {
    name: "tracker_find_task_by_branch",
    description:
      "Look up the task registered against a git branch name. Returns no match when the branch has never been linked to a task.",
    searchableDescription: "which ticket is this branch for, find the task for my PR",
    weight: 14,
  },
  {
    name: "tracker_list_my_active_tasks",
    description:
      "List the tasks assigned to the current member that are not yet complete, most recently updated first.",
    weight: 12,
  },
  {
    name: "tracker_search_my_tasks_by_keyword",
    description:
      "Search the current member's own tasks by keyword, optionally narrowed to a set of workflow statuses.",
    weight: 9,
  },
  {
    name: "tracker_filter_tasks",
    description:
      "Filter tasks across two or more dimensions at once: assignee, workflow status, priority, project, tag, and due date.",
    weight: 8,
  },
  {
    name: "tracker_list_tasks_by_tag",
    description: "List every task carrying a given tag, across all projects the caller can see.",
    weight: 5,
  },
  {
    name: "tracker_list_overdue_tasks",
    description:
      "List tasks whose due date has already passed and which have not reached a completed status.",
    weight: 4,
  },
  {
    name: "tracker_create_task",
    description:
      "Create a task in a project with a title, description, assignee, priority, and due date.",
    weight: 11,
  },
  {
    name: "tracker_create_task_for_branch",
    description:
      "Create a task and register a git branch against it in one step, so later pushes sync to it without another lookup.",
    weight: 7,
  },
  {
    name: "tracker_update_task",
    description:
      "Update a task's fields: workflow status, assignee, title, description, priority, or due date.",
    weight: 16,
  },
  {
    name: "tracker_add_task_comment",
    description:
      "Post a comment on a task: a progress update, a bugfix note, a review summary, or a decision record.",
    weight: 19,
  },
  {
    name: "tracker_link_pr_to_task",
    description:
      "Link a GitHub pull request to a task so the pull request's state and merge status appear on the task.",
    weight: 13,
  },
  {
    name: "tracker_set_pr_tracking",
    description:
      "Turn automatic pull-request linking on or off for a branch or pull request, and optionally delete a task that was auto-created from it.",
    weight: 3,
  },
  {
    name: "tracker_complete_task_with_review",
    description:
      "Move a task to awaiting review, link its pull request, and post the review-request comment in a single call.",
    weight: 6,
  },
  {
    name: "tracker_claim_task_and_branch",
    description:
      "Claim a task for the current member and register the working branch against it before the work starts.",
    weight: 5,
  },
  {
    name: "tracker_unregister_branch_from_task",
    description:
      "Clear the git branch registered on a task, so a later push no longer syncs to it.",
    weight: 2,
  },
  {
    name: "tracker_sync_after_push",
    description:
      "Sync a task after a git push: resolve the branch, deduplicate and link the pull request, and post a progress comment.",
    weight: 15,
  },
  {
    name: "tracker_list_statuses",
    description:
      "List the workspace's workflow statuses in board order, with their keys and which one is the default for new tasks.",
    weight: 7,
  },
  {
    name: "tracker_search_projects",
    description:
      "Find projects by name or topic. Returns each project's lifecycle status, task counts, and a short knowledge summary.",
    weight: 10,
  },
  {
    name: "tracker_create_project",
    description: "Create a new empty project with a title, description, and lifecycle status.",
    weight: 2,
  },
  {
    name: "tracker_entity_lookup",
    description:
      "Fetch one entity in full by id, slug, or URL: a task with its comment history, a project, or a document.",
    weight: 12,
  },
  {
    name: "tracker_list_members",
    description:
      "List the members of the current workspace with their member ids and display names.",
    weight: 3,
  },
  {
    name: "tracker_get_project_pending_changes",
    description:
      "List a project's pending proposals: suggested task updates, document edits, and drafted tasks awaiting a decision.",
    weight: 4,
  },
  {
    name: "tracker_deep_research",
    description:
      "Search every task, comment, and document in the workspace exhaustively. Slow, and a last resort once cheaper lookups have missed.",
    weight: 3,
  },
  {
    name: "tracker_upload_file",
    description: "Upload a file or image and attach it to a task, a comment, or a document.",
    weight: 4,
  },

  // Observed but never described. These can never be retrieved, and the
  // Playground's "No description" filter is what makes that visible.
  { name: "legacy_metrics_export", weight: 3 },
  { name: "internal_webhook_replay", weight: 2 },
];

/** Every demo tool name, in catalog order. */
export const DEMO_TOOL_NAMES: readonly string[] = DEMO_TOOLS.map((tool) => tool.name);

/** Only the tools a definition sync would actually carry. */
export function describedDemoTools(): {
  name: string;
  description: string;
  searchableDescription: string;
}[] {
  return DEMO_TOOLS.filter(
    (tool): tool is DemoTool & { description: string } => tool.description !== undefined,
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Mirrors ingest, which copies the description across unless the runtime
    // registered something different (`lib/catalogs/queries.ts`). Resolving it
    // here keeps the seeder from re-deciding a rule the product already owns.
    searchableDescription: tool.searchableDescription ?? tool.description,
  }));
}
