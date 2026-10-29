/**
 * Runtime-managed catalog entries for the demo project.
 *
 * `tool_definitions` alone is not enough to exercise the tools catalog: that
 * table is the "Cloud has a description" state, and every row built from it
 * renders as *observed only*, read-only, with nothing to edit. The states that
 * actually matter live in `runtime_catalog_entries`: a definition the runtime
 * ingested, which Cloud may override the searchable description of.
 *
 * Without these rows a local catalog is 34 identical grey eyes, no Edit button
 * anywhere, and no way to reach the edit modal at all.
 *
 * The surface is deliberately large and densely named. A catalog of thirty
 * well-separated tools makes both retrieval and pagination look easy; the
 * interesting cases only appear once it collides with itself and spills past a
 * page. Most entries carry no telemetry, which is also the realistic shape: a
 * runtime registers its whole integration surface, and only a fraction of it
 * ever gets called.
 */
import { createHash } from "node:crypto";
import { DEMO_TOOLS } from "@/lib/console/seed/demo-tools";
import type { NewRuntimeCatalogEntry } from "@/lib/ingest/runtime-catalog/schema";

export interface DemoRuntimeTool {
  name: string;
  description: string;
  /**
   * Set when the runtime itself registered different text for retrieval. Left
   * undefined for the common case where the two are the same value, which is
   * what the ingest default produces and what the edit modal has to state
   * rather than print twice.
   */
  searchableDescription?: string;
  /** A Cloud-side operator edit, layered over whatever the runtime sent. */
  cloudOverride?: string;
  /** The runtime reports that it is consuming Cloud's overrides. */
  adopted?: boolean;
  tags?: string[];
  params?: Record<string, "string" | "number" | "boolean">;
  required?: string[];
}

/**
 * Registered by the runtime but never called, so they carry a definition and
 * no usage. Named to overlap on purpose: four different ways to "find an
 * issue", three to "post a message".
 */
export const DEMO_RUNTIME_TOOLS: readonly DemoRuntimeTool[] = [
  /* Issue tracker */
  {
    name: "linear_search_issues",
    description:
      "Search issues by full-text query across titles, descriptions, and comments, scoped to a team or the whole workspace.",
    params: { query: "string", teamId: "string", limit: "number" },
    required: ["query"],
  },
  {
    name: "linear_get_issue",
    description:
      "Fetch one issue in full by identifier or URL, including its description, labels, assignee, and comment thread.",
    params: { id: "string" },
    required: ["id"],
  },
  {
    name: "linear_list_issues_by_assignee",
    description:
      "List the issues assigned to one member, newest first, optionally narrowed to open states.",
    params: { assigneeId: "string", openOnly: "boolean" },
    required: ["assigneeId"],
  },
  {
    name: "linear_list_issues_by_label",
    description: "List every issue carrying a given label across the projects the caller can see.",
    params: { label: "string" },
    required: ["label"],
  },
  {
    name: "linear_create_issue",
    description: "Create an issue with a title, description, team, assignee, priority, and labels.",
    params: { title: "string", teamId: "string", description: "string", priority: "number" },
    required: ["title", "teamId"],
  },
  {
    name: "linear_update_issue",
    description: "Update an issue's state, assignee, priority, title, description, or labels.",
    params: { id: "string", stateId: "string", assigneeId: "string" },
    required: ["id"],
  },
  {
    name: "linear_comment_on_issue",
    description: "Post a comment on an issue thread.",
    params: { issueId: "string", body: "string" },
    required: ["issueId", "body"],
  },
  {
    name: "linear_list_teams",
    description:
      "List the workspace's teams with their identifiers, keys, and default workflow states.",
    tags: ["reference"],
  },
  {
    name: "linear_list_workflow_states",
    description:
      "List a team's workflow states in board order, with which one is the default for new issues.",
    params: { teamId: "string" },
    required: ["teamId"],
    tags: ["reference"],
  },
  {
    name: "linear_link_pr_to_issue",
    description:
      "Attach a pull request to an issue so its review state and merge status surface on the issue.",
    params: { issueId: "string", prUrl: "string" },
    required: ["issueId", "prUrl"],
  },

  /* Chat */
  {
    name: "slack_post_message",
    description: "Post a message to a channel or thread as the configured bot user.",
    searchableDescription:
      "Send, post, or write a message into a Slack channel, thread, or direct message. Announce, notify, ping, or alert a team.",
    params: { channel: "string", text: "string", threadTs: "string" },
    required: ["channel", "text"],
  },
  {
    name: "slack_update_message",
    description: "Edit a message the bot already posted, by channel and timestamp.",
    params: { channel: "string", ts: "string", text: "string" },
    required: ["channel", "ts", "text"],
  },
  {
    name: "slack_search_messages",
    description: "Search message history across the channels the bot can read.",
    params: { query: "string", count: "number" },
    required: ["query"],
  },
  {
    name: "slack_list_channels",
    description: "List the channels the bot is a member of, with their ids, names, and topics.",
    tags: ["reference"],
  },
  {
    name: "slack_upload_file",
    description: "Upload a file or snippet and share it into a channel or thread.",
    params: { channel: "string", filename: "string", content: "string" },
    required: ["channel", "filename", "content"],
  },
  {
    name: "slack_add_reaction",
    description: "Add an emoji reaction to a message.",
    params: { channel: "string", ts: "string", name: "string" },
    required: ["channel", "ts", "name"],
  },
  {
    name: "slack_open_dm",
    description: "Open or fetch a direct-message channel with one user.",
    params: { userId: "string" },
    required: ["userId"],
  },

  /* Errors and monitoring */
  {
    name: "sentry_search_issues",
    description: "Search error groups by message, culprit, release, or tag within a project.",
    searchableDescription:
      "Find crashes, exceptions, errors, or stack traces reported by an application. Look up what is failing in production.",
    params: { query: "string", projectSlug: "string" },
    required: ["query"],
  },
  {
    name: "sentry_get_issue",
    description:
      "Fetch one error group with its latest event, stack trace, breadcrumbs, and occurrence counts.",
    params: { issueId: "string" },
    required: ["issueId"],
  },
  {
    name: "sentry_list_recent_issues",
    description: "List a project's most recently seen unresolved error groups.",
    params: { projectSlug: "string", limit: "number" },
    required: ["projectSlug"],
  },
  {
    name: "sentry_resolve_issue",
    description: "Mark an error group resolved, optionally in the next release.",
    params: { issueId: "string", inNextRelease: "boolean" },
    required: ["issueId"],
  },
  {
    name: "sentry_assign_issue",
    description: "Assign an error group to a team member.",
    params: { issueId: "string", assignee: "string" },
    required: ["issueId", "assignee"],
  },
  {
    name: "sentry_list_releases",
    description: "List a project's releases with their commit ranges and first-seen error counts.",
    params: { projectSlug: "string" },
    required: ["projectSlug"],
    tags: ["reference"],
  },
  {
    name: "datadog_query_metrics",
    description: "Run a metric query over a time range and return the resulting series.",
    params: { query: "string", from: "string", to: "string" },
    required: ["query", "from", "to"],
  },
  {
    name: "datadog_list_monitors",
    description: "List configured monitors with their current state and last transition time.",
    tags: ["reference"],
  },
  {
    name: "datadog_mute_monitor",
    description: "Mute a monitor for a duration, with an optional reason recorded on the mute.",
    params: { monitorId: "number", durationMinutes: "number", reason: "string" },
    required: ["monitorId"],
  },
  {
    name: "datadog_search_logs",
    description:
      "Search indexed logs by query and time range, returning matching records with their attributes.",
    params: { query: "string", from: "string", to: "string", limit: "number" },
    required: ["query"],
  },

  /* Database */
  {
    name: "postgres_run_query",
    description:
      "Run a read-only SQL query against the primary database and return the result rows.",
    searchableDescription:
      "Query, select, read, or inspect data in a SQL or Postgres database. Run a read-only statement and get rows back.",
    params: { sql: "string", limit: "number" },
    required: ["sql"],
  },
  {
    name: "postgres_explain_query",
    description: "Return the query planner's output for a statement without executing it.",
    params: { sql: "string", analyze: "boolean" },
    required: ["sql"],
  },
  {
    name: "postgres_describe_table",
    description:
      "Describe a table: its columns and types, indexes, constraints, and approximate row count.",
    params: { schema: "string", table: "string" },
    required: ["table"],
  },
  {
    name: "postgres_list_tables",
    description: "List the tables in a schema with their sizes on disk.",
    params: { schema: "string" },
    tags: ["reference"],
  },
  {
    name: "postgres_list_slow_queries",
    description:
      "List the slowest statements recorded by pg_stat_statements, ordered by total time.",
    params: { limit: "number" },
  },
  {
    name: "postgres_list_locks",
    description: "List current lock waits, showing which statement is blocking which.",
    tags: ["diagnostics"],
  },
  {
    name: "postgres_list_migrations",
    description: "List applied schema migrations in order, with when each ran.",
    tags: ["reference"],
  },

  /* Cloud storage and deploys */
  {
    name: "s3_list_objects",
    description: "List objects under a bucket prefix with their sizes and last-modified times.",
    params: { bucket: "string", prefix: "string", maxKeys: "number" },
    required: ["bucket"],
  },
  {
    name: "s3_get_object",
    description: "Download one object's contents by bucket and key.",
    params: { bucket: "string", key: "string" },
    required: ["bucket", "key"],
  },
  {
    name: "s3_put_object",
    description: "Upload contents to a bucket key, replacing any object already there.",
    params: { bucket: "string", key: "string", body: "string" },
    required: ["bucket", "key", "body"],
  },
  {
    name: "s3_delete_object",
    description: "Delete one object by bucket and key.",
    params: { bucket: "string", key: "string" },
    required: ["bucket", "key"],
  },
  {
    name: "s3_presign_url",
    description: "Create a time-limited signed URL for reading or writing one object.",
    params: { bucket: "string", key: "string", expiresIn: "number" },
    required: ["bucket", "key"],
  },
  {
    name: "deploy_list_deployments",
    description: "List a project's deployments with their state, target environment, and commit.",
    params: { projectId: "string", limit: "number" },
    required: ["projectId"],
  },
  {
    name: "deploy_get_deployment_logs",
    description: "Fetch the build and runtime logs for one deployment.",
    params: { deploymentId: "string" },
    required: ["deploymentId"],
  },
  {
    name: "deploy_promote_deployment",
    description: "Promote an existing preview deployment to production without rebuilding.",
    params: { deploymentId: "string" },
    required: ["deploymentId"],
  },
  {
    name: "deploy_rollback_production",
    description: "Roll production back to the previously promoted deployment.",
    params: { projectId: "string" },
    required: ["projectId"],
  },
  {
    name: "deploy_list_env_vars",
    description: "List a project's environment variables by target, with values redacted.",
    params: { projectId: "string" },
    required: ["projectId"],
    tags: ["reference"],
  },

  /* Payments */
  {
    name: "billing_get_customer",
    description:
      "Fetch one customer with their billing details, default payment method, and metadata.",
    params: { customerId: "string" },
    required: ["customerId"],
  },
  {
    name: "billing_search_customers",
    description: "Search customers by email, name, or metadata field.",
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "billing_list_subscriptions",
    description: "List a customer's subscriptions with their status, plan, and current period.",
    params: { customerId: "string" },
    required: ["customerId"],
  },
  {
    name: "billing_cancel_subscription",
    description: "Cancel a subscription immediately or at the end of the current period.",
    params: { subscriptionId: "string", atPeriodEnd: "boolean" },
    required: ["subscriptionId"],
  },
  {
    name: "billing_list_invoices",
    description: "List a customer's invoices with their status, totals, and payment attempts.",
    params: { customerId: "string", status: "string" },
    required: ["customerId"],
  },
  {
    name: "billing_refund_charge",
    description: "Refund a charge in full or in part, with a reason recorded on the refund.",
    params: { chargeId: "string", amount: "number", reason: "string" },
    required: ["chargeId"],
  },

  /* Docs and knowledge */
  {
    name: "notion_search_pages",
    description: "Search pages and databases by title and body text across the workspace.",
    params: { query: "string" },
    required: ["query"],
  },
  {
    name: "notion_get_page",
    description: "Fetch one page's properties and its block content as structured blocks.",
    params: { pageId: "string" },
    required: ["pageId"],
  },
  {
    name: "notion_append_blocks",
    description: "Append blocks to the end of a page's content.",
    params: { pageId: "string", markdown: "string" },
    required: ["pageId", "markdown"],
  },
  {
    name: "notion_query_database",
    description:
      "Query a database with filters and sorts, returning matching pages and their properties.",
    params: { databaseId: "string", filter: "string" },
    required: ["databaseId"],
  },
  {
    name: "confluence_search",
    description: "Search Confluence spaces for pages matching a query.",
    params: { query: "string", spaceKey: "string" },
    required: ["query"],
  },

  /* Email and calendar */
  {
    name: "gmail_search_threads",
    description:
      "Search mail threads with Gmail query syntax and return matching thread summaries.",
    params: { query: "string", maxResults: "number" },
    required: ["query"],
  },
  {
    name: "gmail_send_message",
    description: "Send an email with a subject, body, and recipient list.",
    searchableDescription:
      "Send, write, compose, or reply to an email. Contact someone over mail rather than chat.",
    params: { to: "string", subject: "string", body: "string" },
    required: ["to", "subject", "body"],
  },
  {
    name: "gmail_create_draft",
    description: "Create an unsent draft message the user can review before sending.",
    params: { to: "string", subject: "string", body: "string" },
    required: ["to", "subject", "body"],
  },
  {
    name: "calendar_list_events",
    description: "List calendar events in a time range with their attendees and locations.",
    params: { calendarId: "string", from: "string", to: "string" },
    required: ["from", "to"],
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event with a title, time range, attendees, and description.",
    params: { title: "string", start: "string", end: "string" },
    required: ["title", "start", "end"],
  },
  {
    name: "calendar_find_free_slot",
    description: "Find the earliest window in which every listed attendee is free.",
    params: { attendees: "string", durationMinutes: "number", withinDays: "number" },
    required: ["attendees", "durationMinutes"],
  },
];

/**
 * Which of the described demo tools carry an interesting Cloud-side state, so
 * the catalog shows more than one flavour of managed row. Keyed by name rather
 * than index so reordering `DEMO_TOOLS` cannot silently move them.
 */
const DEMO_TOOL_STATES: Record<string, Pick<DemoRuntimeTool, "cloudOverride" | "adopted">> = {
  // Cloud override, not yet picked up by the runtime: "Saved in Cloud only".
  test_runner: {
    cloudOverride:
      "Run tests, a test suite, a single spec, or a failing case, and report which assertions passed and which failed.",
    adopted: false,
  },
  // Cloud override the runtime is already serving: "Live in your runtime".
  tracker_search_operations: {
    cloudOverride:
      "Find which project-management operation answers an intent, when you know what you want to do but not what it is called.",
    adopted: true,
  },
  // Override that only lightly edits the original, so the diff is legible.
  tracker_add_task_comment: {
    cloudOverride:
      "Post a comment on a task: a progress update, a bugfix note, a review summary, a decision record, or a handover.",
    adopted: false,
  },
};

/**
 * Every runtime-managed entry for the demo project.
 *
 * The two deliberately undescribed demo tools are left out: "observed but never
 * registered" is a real state, and it is the one that explains a row with no
 * Edit button.
 */
export function demoRuntimeCatalogEntries(
  projectId: string,
  now: Date = new Date(),
): NewRuntimeCatalogEntry[] {
  const fromTelemetry = DEMO_TOOLS.filter(
    (tool): tool is (typeof DEMO_TOOLS)[number] & { description: string } =>
      tool.description !== undefined,
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    // `DEMO_TOOLS` owns the runtime's own searchable text, so `buildDemoRanker`
    // and this seeder cannot disagree about what a prompt matches on. Only the
    // Cloud-side states live here.
    ...(tool.searchableDescription === undefined
      ? {}
      : { searchableDescription: tool.searchableDescription }),
    ...(DEMO_TOOL_STATES[tool.name] ?? {}),
  }));

  return [...fromTelemetry, ...DEMO_RUNTIME_TOOLS].map((tool) => entry(projectId, tool, now));
}

function entry(projectId: string, tool: DemoRuntimeTool, now: Date): NewRuntimeCatalogEntry {
  // Adoption means the runtime has taken Cloud's text as its own, so it reports
  // that text back as its searchable description. Without this the entry looks
  // adopted and out of sync at once, which `getRetrievalDescriptionAdoption`
  // reads as still-pending, the one state the demo would then never show.
  const searchableDescription =
    tool.adopted && tool.cloudOverride
      ? tool.cloudOverride
      : (tool.searchableDescription ?? tool.description);
  const inputSchema = tool.params ? jsonSchema(tool) : null;
  return {
    projectId,
    kind: "tool",
    entryId: tool.name,
    name: tool.name,
    description: tool.description,
    tags: tool.tags ?? [],
    inputSchema,
    outputSchema: null,
    searchableDescription,
    // What the runtime reports about its own retrieval text, which is true both
    // when it registered its own and when it has adopted Cloud's.
    searchableDescriptionOverridden: searchableDescription !== tool.description,
    useCloudDefinitions: tool.adopted ?? false,
    searchableDescriptionOverride: tool.cloudOverride ?? null,
    contentHash: contentHash(tool),
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function jsonSchema(tool: DemoRuntimeTool): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(tool.params ?? {}).map(([name, type]) => [name, { type }]),
    ),
    ...(tool.required ? { required: tool.required } : {}),
    additionalProperties: false,
  };
}

/** Ingest keys freshness on this, so it has to change when the content does. */
function contentHash(tool: DemoRuntimeTool): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        tool.name,
        tool.description,
        tool.searchableDescription ?? null,
        tool.tags ?? [],
        tool.params ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}
