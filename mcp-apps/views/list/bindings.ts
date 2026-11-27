import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { ListConfig } from "../../shell/config";
import type { ViewBindings } from "../../shell/types";

export type ListBinding = McpAppBinding & { config: ListConfig };

export const TASK_TONES = {
  failing: "danger",
  slow: "warning",
  watch: "info",
  healthy: "success",
} as const;
export const TASK_LABELS = { failing: "Failing", slow: "Slow", watch: "Watch", healthy: "Healthy" };
export const EVIDENCE_TONES = { early: "neutral", solid: "info", strong: "success" } as const;
export const EVIDENCE_LABELS = { early: "Early", solid: "Solid", strong: "Strong" };
export const SKILL_TONES = { published: "success", draft: "neutral", archived: "neutral" } as const;
export const SKILL_LABELS = { published: "Published", draft: "Draft", archived: "Archived" };
const SYNC_LABELS = { fresh: "Synced", stale: "Stale", inactive: "Inactive" };

/** Agent health's row status (components/health/v2/issue-rows.ts, ISSUE_TONE_LABEL). */
const ISSUE_TONES = { fix_now: "danger", watch: "warning", early: "neutral" } as const;
const ISSUE_TONE_LABELS = { fix_now: "Fix now", watch: "Watch", early: "Too early" };

/** A scorer's switch, and an alert's state as the Alerts page says it. */
export const SWITCH_TONES = { on: "success", off: "neutral" } as const;
export const SWITCH_LABELS = { on: "On", off: "Off" };
export const ALERT_TONES = {
  OK: "success",
  Alerting: "danger",
  "No data": "neutral",
  Paused: "neutral",
  "Needs attention": "warning",
} as const;

/** Lists of records: one view, the columns and filters per tool. */
export const listBindings: ListBinding[] = [
  {
    tool: "list_traces",
    config: {
      rows: "traces",
      rowKey: "traceId",
      title: "rootName",
      noun: { one: "run", many: "runs" },
      // components/traces/v2/RunsTable.tsx: status, the run, started, duration, tools, tokens, cost, in its cells.
      // `status`, `ask` and `tools` come with includeDetails; without them the span status and root name stand in.
      columns: [
        {
          key: "status",
          orKey: "statusCode",
          label: "Status",
          format: "status",
          width: "7rem",
          tones: {
            completed: "success",
            failed: "danger",
            incomplete: "neutral",
            "0": "neutral",
            "1": "success",
            "2": "danger",
          },
          labels: {
            completed: "Completed",
            failed: "Failed",
            incomplete: "Incomplete",
            "0": "Unset",
            "1": "OK",
            "2": "Error",
          },
        },
        { key: "ask", orKey: "rootName", label: "Run" },
        { key: "startedAt", label: "Started", format: "relative", width: "7rem" },
        { key: "durationMs", label: "Duration", format: "duration", width: "6rem" },
        {
          key: "tools",
          label: "Tools",
          format: "tools",
          hiddenBelow: "md",
          sortable: false,
          optional: true,
        },
        { key: "totalTokens", label: "Tokens", format: "number", width: "6rem", hiddenBelow: "sm" },
        { key: "costUsd", label: "Cost", format: "currency", width: "6rem", hiddenBelow: "sm" },
      ],
      search: ["rootName", "serviceName", "traceId", "ask"],
      filters: [
        {
          key: "statusCode",
          label: "Status",
          kind: "values",
          badgeLabels: { "0": "Unset", "1": "OK", "2": "Error" },
        },
        { key: "serviceName", label: "Service", kind: "values" },
        { key: "experimentName", label: "Experiment", kind: "values" },
      ],
      defaultSort: { key: "startedAt", direction: "desc" },
      // list_traces' `sort`: started, duration, tokens or cost, the most first.
      sortArg: {
        started: { key: "startedAt", direction: "desc" },
        duration: { key: "durationMs", direction: "desc" },
        tokens: { key: "totalTokens", direction: "desc" },
        cost: { key: "costUsd", direction: "desc" },
      },
      detail: { tool: "get_trace", args: { traceId: "traceId" } },
      cursor: { next: "nextCursor", param: "cursor" },
      empty: {
        title: "No runs in this window",
        description:
          "Runs appear once your agent sends traces. Widen the window or clear the filters.",
      },
    },
  },
  {
    tool: "list_intents",
    config: {
      rows: "intents",
      rowKey: "id",
      title: "name",
      noun: { one: "intent", many: "intents" },
      // components/intents/v2/TopicsTable.tsx: intent, asks, answered (its DotMeter), sentiment (its bar).
      columns: [
        { key: "name", label: "Intent", format: "entity", noun: "intent" },
        { key: "turns", label: "Asks", format: "number", width: "5.5rem" },
        {
          key: "answeredShare",
          label: "Answered",
          format: "meter",
          warnKey: "mostlyUnanswered",
          width: "10rem",
        },
        {
          key: "sentiment",
          label: "Sentiment",
          format: "sentiment",
          width: "7rem",
          hiddenBelow: "md",
        },
      ],
      search: ["name", "description"],
      filters: [{ key: "mostlyUnanswered", label: "Mostly unanswered", kind: "flag" }],
      defaultSort: { key: "turns", direction: "desc" },
      // list_intents' `sort`: busiest, least answered, most negative, or A to Z.
      sortArg: {
        turns: { key: "turns", direction: "desc" },
        answered: { key: "answeredShare", direction: "asc" },
        negative: { key: "sentiment", direction: "desc" },
        name: { key: "name", direction: "asc" },
      },
      detail: { tool: "get_intent", args: { intentId: "id" } },
      empty: {
        title: "No intents yet",
        description: "Intents appear after the first reading of your agent's conversations.",
      },
    },
  },
  {
    // components/tasks/TasksTable.tsx (Agent health's tasks): busiest first.
    tool: "list_tasks",
    config: {
      rows: "tasks",
      rowKey: "id",
      title: "name",
      noun: { one: "task", many: "tasks" },
      columns: [
        { key: "name", label: "Task", format: "entity", noun: "task" },
        { key: "status", label: "Status", format: "taskStatus", width: "6rem", hiddenBelow: "md" },
        { key: "runs", label: "Runs", format: "number", width: "5.5rem" },
        { key: "finishRate", label: "Finish rate", format: "share", width: "6.5rem" },
        {
          key: "correctionsPer100",
          label: "Self-corrections per 100 turns",
          format: "per100",
          width: "8rem",
          hiddenBelow: "md",
        },
        { key: "issues", label: "Issues", format: "number", width: "5rem", hiddenBelow: "sm" },
      ],
      search: ["name", "description"],
      filters: [{ key: "status", label: "Status", kind: "values", badgeLabels: TASK_LABELS }],
      defaultSort: { key: "runs", direction: "desc" },
      detail: { tool: "get_task", args: { taskId: "id" } },
      empty: {
        title: "No tasks yet",
        description: "Tasks appear after Agent health reads your agent's runs.",
      },
    },
  },
  {
    // components/fixes/v2/FixesList.tsx: in the tool's order, biggest effect first.
    tool: "list_fixes",
    config: {
      rows: "fixes",
      rowKey: "id",
      title: "title",
      noun: { one: "fix", many: "fixes" },
      columns: [
        { key: "title", label: "Fix", format: "entity", noun: "fix" },
        { key: "kindLabel", label: "Kind", width: "10rem", hiddenBelow: "md" },
        { key: "effect.value", label: "Effect", width: "8rem" },
        {
          key: "evidence.strength",
          label: "Evidence",
          format: "badge",
          width: "6rem",
          tones: EVIDENCE_TONES,
          labels: EVIDENCE_LABELS,
        },
        {
          key: "status",
          label: "Status",
          format: "badge",
          width: "5.5rem",
          tones: { open: "neutral", applied: "success" },
          labels: { open: "Open", applied: "Applied" },
        },
      ],
      search: ["title", "why", "kindLabel"],
      filters: [
        { key: "kindLabel", label: "Kind of fix", kind: "values" },
        {
          key: "evidence.strength",
          label: "Evidence",
          kind: "values",
          badgeLabels: EVIDENCE_LABELS,
        },
        {
          key: "status",
          label: "Status",
          kind: "values",
          badgeLabels: { open: "Open", applied: "Applied" },
        },
      ],
      detail: { tool: "get_fix", args: { fixId: "id" } },
      empty: {
        title: "No fixes yet",
        description:
          "Fixes appear when Agent health finds an issue with a clear change, or when your tasks show steps to merge or retire.",
      },
    },
  },
  {
    // Agent health's issues (components/health/v2/IssuesSection.tsx), worst first as the tool orders them.
    // No detail: an insight's own tool is get_fix, which fails for one with no fix yet.
    tool: "list_insights",
    config: {
      rows: "insights",
      rowKey: "id",
      title: "title",
      noun: { one: "issue", many: "issues" },
      columns: [
        { key: "title", label: "Issue", format: "entity", noun: "issue" },
        {
          key: "status",
          label: "Status",
          format: "badge",
          width: "6rem",
          tones: { open: "warning", resolved: "success" },
          labels: { open: "Open", resolved: "Resolved" },
        },
        { key: "figure.display", label: "Measure", width: "6rem", align: "right" },
        { key: "n", label: "Seen in", format: "number", width: "5.5rem", hiddenBelow: "sm" },
        { key: "lastSeenAt", label: "Last seen", format: "date", width: "7rem", hiddenBelow: "sm" },
      ],
      search: ["title", "claim", "whatToDo"],
      filters: [
        { key: "kind", label: "Kind", kind: "values" },
        {
          key: "status",
          label: "Status",
          kind: "values",
          badgeLabels: { open: "Open", resolved: "Resolved" },
        },
      ],
      empty: { title: "No issues", description: "Nothing stands out in the latest reading." },
      // The tool returns every issue; Agent health lists one row per kind of issue, most points first
      // (components/health/v2/IssuesSection.tsx: issue, status, if fixed, measure). The server sends
      // those rows for the view, so the list is the page's.
      fromView: {
        kind: "health_issue_rows",
        rows: "rows",
        rowKey: "key",
        title: "title",
        columns: [
          { key: "title", label: "Issue", format: "entity", noun: "issue" },
          { key: "about", label: "About", hiddenBelow: "sm" },
          {
            key: "tone",
            label: "Status",
            format: "status",
            width: "7rem",
            tones: ISSUE_TONES,
            labels: ISSUE_TONE_LABELS,
          },
          { key: "points", label: "If fixed", format: "points", width: "5.5rem" },
          { key: "figure.display", label: "Measure", width: "6rem", align: "right" },
        ],
        search: ["title", "about"],
        filters: [{ key: "tone", label: "Status", kind: "values", badgeLabels: ISSUE_TONE_LABELS }],
      },
    },
  },
  {
    // components/catalog/v2/SkillsCatalog.tsx: recently updated first. Pages by offset, which the
    // list does not drive: a cut list says so and asks for narrower filters.
    tool: "list_skills",
    config: {
      rows: "skills",
      rowKey: "id",
      title: "name",
      noun: { one: "skill", many: "skills" },
      columns: [
        { key: "name", label: "Name", format: "entity", noun: "skill" },
        {
          key: "status",
          label: "Status",
          format: "badge",
          width: "6.5rem",
          tones: SKILL_TONES,
          labels: SKILL_LABELS,
        },
        { key: "description", label: "Description", hiddenBelow: "md" },
        { key: "version", label: "Version", format: "number", width: "5rem", hiddenBelow: "sm" },
        { key: "updatedAt", label: "Updated", format: "date", width: "7rem" },
      ],
      search: ["name", "description"],
      filters: [{ key: "status", label: "Status", kind: "values", badgeLabels: SKILL_LABELS }],
      defaultSort: { key: "updatedAt", direction: "desc" },
      // list_skills' `sort` (with `direction`): by runs it has no column here, so no header is marked.
      sortArg: {
        name: { key: "name", direction: "asc" },
        updated: { key: "updatedAt", direction: "desc" },
      },
      detail: { tool: "get_skill", args: { skillId: "id" } },
      empty: {
        title: "No skills yet",
        description:
          "A skill is a set of instructions your agent can find and follow when a request calls for it.",
      },
    },
  },
  {
    // The Ship page (components/lineage/ShipmentsTable.tsx), newest first. No detail: get_lineage
    // needs a fixed kind a binding cannot pass, and answers a pointer, not the shipment.
    tool: "list_shipments",
    config: {
      rows: "shipments",
      rowKey: "id",
      title: "title",
      noun: { one: "shipped change", many: "shipped changes" },
      columns: [
        { key: "title", label: "Change" },
        { key: "source.label", label: "From", hiddenBelow: "sm" },
        { key: "shippedAt", label: "Shipped", format: "date", width: "7rem" },
      ],
      search: ["title", "source.label"],
      defaultSort: { key: "shippedAt", direction: "desc" },
      empty: {
        title: "Nothing shipped yet",
        description:
          "A fix you apply or mark as shipped shows up here, linked to the fix it came from.",
      },
    },
  },
  {
    // Settings › Developer (components/settings/v2/SdkEventsTable.tsx), newest first. Only the
    // default view: rejects and drops come back under other keys, and read as this empty state.
    tool: "list_sdk_events",
    config: {
      rows: "events",
      rowKey: "identifier",
      title: "label",
      noun: { one: "event", many: "events" },
      columns: [
        { key: "label", label: "Event", width: "8rem" },
        { key: "subject", label: "About", content: true },
        { key: "source", label: "Source", hiddenBelow: "md" },
        {
          key: "durationMs",
          label: "Duration",
          format: "duration",
          width: "6rem",
          hiddenBelow: "sm",
        },
        { key: "at", label: "Time", format: "date", width: "7rem" },
      ],
      search: ["label", "subject", "source", "identifier", "traceId"],
      filters: [
        { key: "label", label: "Event", kind: "values" },
        { key: "source", label: "Source", kind: "values" },
      ],
      defaultSort: { key: "at", direction: "desc" },
      detail: { tool: "get_sdk_event", args: { identifier: "identifier" } },
      empty: {
        title: "No SDK events in this window",
        description:
          "Try a longer window. Dropped and rejected events (view rejects or drops) are in the tool's text answer.",
      },
    },
  },
  {
    // Traces › Logs (components/traces/v2/LogsView.tsx), newest first, cursor-paged. No get_log;
    // the body the console shows in its panel is a column here.
    tool: "list_logs",
    config: {
      rows: "logs",
      rowKey: "id",
      title: "label",
      noun: { one: "log", many: "logs" },
      columns: [
        { key: "occurredAt", label: "Time", format: "date", width: "7rem" },
        { key: "label", label: "Log", width: "10rem" },
        { key: "body", label: "Body", content: true, hiddenBelow: "md" },
        { key: "experimentName", label: "Experiment", width: "7rem", hiddenBelow: "sm" },
        { key: "serviceName", label: "Service", width: "8rem", hiddenBelow: "sm" },
        { key: "traceId", label: "Run", format: "id", width: "8.5rem", sortable: false },
      ],
      search: ["label", "eventName", "body", "traceId", "serviceName"],
      filters: [
        { key: "label", label: "Log", kind: "values" },
        { key: "experimentName", label: "Experiment", kind: "values" },
        { key: "serviceName", label: "Service", kind: "values" },
      ],
      defaultSort: { key: "occurredAt", direction: "desc" },
      cursor: { next: "nextCursor", param: "cursor" },
      empty: {
        title: "No logs in this window",
        description:
          "Ratel SDK records, like experiment results and delayed outcomes, show up here as they arrive.",
      },
    },
  },
  {
    // The organization's projects (components/org/v2/ProjectsList.tsx), oldest first.
    tool: "list_projects",
    config: {
      rows: "projects",
      rowKey: "id",
      title: "name",
      noun: { one: "project", many: "projects" },
      columns: [
        { key: "name", label: "Project" },
        { key: "slug", label: "Service name", hiddenBelow: "sm" },
        { key: "createdAt", label: "Created", format: "date", width: "7rem" },
      ],
      search: ["name", "slug"],
      defaultSort: { key: "createdAt", direction: "asc" },
      detail: { tool: "get_project_overview", args: { projectId: "id" } },
      empty: {
        title: "No projects yet",
        description: "Create the first project to get an API key and start collecting traces.",
      },
    },
  },
  {
    // Traces › Spans grouped (components/traces/v2/SpansView.tsx), most spans first. A row has no
    // detail tool: in the console it filters the spans.
    tool: "list_span_groups",
    config: {
      rows: "operations",
      rowKey: "key",
      title: "key",
      noun: { one: "group", many: "groups" },
      columns: [
        { key: "key", label: "Name" },
        { key: "count", label: "Spans", format: "number", width: "6rem" },
        { key: "errorRate", label: "Failed", format: "percent", width: "5.5rem" },
        {
          key: "p50DurationMs",
          label: "Median",
          format: "duration",
          width: "6rem",
          hiddenBelow: "sm",
        },
        { key: "p95DurationMs", label: "p95", format: "duration", width: "6rem" },
        {
          key: "totalTokens",
          label: "Tokens",
          format: "number",
          width: "6.5rem",
          hiddenBelow: "md",
        },
        { key: "costUsd", label: "Cost", format: "currency", width: "6rem", hiddenBelow: "sm" },
      ],
      search: ["key"],
      defaultSort: { key: "count", direction: "desc" },
      empty: { title: "No spans in this window", description: "Try a wider window." },
    },
  },
  {
    // The Tools catalog (components/catalog/v2/ToolsCatalog.tsx), as its usage half: most calls first.
    tool: "list_invoked_tools",
    config: {
      rows: "tools",
      rowKey: "name",
      title: "name",
      noun: { one: "tool", many: "tools" },
      columns: [
        { key: "name", label: "Name", format: "entity", noun: "tool" },
        { key: "calls", label: "Calls", format: "bar", width: "9rem" },
        { key: "tokens", label: "Tokens", format: "number", width: "7rem", hiddenBelow: "sm" },
        { key: "costUsd", label: "Cost", format: "currency", width: "6rem" },
        { key: "lastSeenAt", label: "Last seen", format: "date", width: "7rem", hiddenBelow: "sm" },
      ],
      search: ["name"],
      defaultSort: { key: "calls", direction: "desc" },
      empty: {
        title: "No tools yet",
        description: "Tools show up here once your agent calls them.",
      },
    },
  },
  {
    // The Tools catalog's synced half: what each runtime declares, most calls first.
    tool: "list_declared_tools",
    config: {
      rows: "tools",
      rowKey: "toolId",
      title: "name",
      noun: { one: "tool", many: "tools" },
      columns: [
        { key: "name", label: "Name", format: "entity", noun: "tool" },
        { key: "description", label: "Description", hiddenBelow: "md" },
        { key: "calls", label: "Calls", format: "number", width: "5.5rem" },
        { key: "lastUsedAt", label: "Last seen", format: "date", width: "7rem", hiddenBelow: "sm" },
        { key: "sourceId", label: "Source", width: "8rem", hiddenBelow: "sm" },
        {
          key: "sourceStatus",
          label: "Sync",
          format: "badge",
          width: "5.5rem",
          tones: { fresh: "success", stale: "warning", inactive: "neutral" },
          labels: SYNC_LABELS,
        },
      ],
      search: ["name", "description", "sourceId"],
      filters: [
        { key: "sourceId", label: "Source", kind: "values" },
        { key: "sourceStatus", label: "Sync", kind: "values", badgeLabels: SYNC_LABELS },
        {
          key: "hasDescription",
          label: "Description",
          kind: "values",
          badgeLabels: { true: "Described", false: "Missing" },
        },
      ],
      defaultSort: { key: "calls", direction: "desc" },
      empty: {
        title: "No tools yet",
        description: "Tools show up here once your runtime registers them.",
      },
    },
  },
  // Custom monitoring (RTL-213): the console's Scorers, Alerts and Dashboards pages.
  {
    tool: "list_scorers",
    config: {
      rows: "scorers",
      rowKey: "id",
      title: "name",
      noun: { one: "scorer", many: "scorers" },
      columns: [
        { key: "name", label: "Scorer" },
        {
          key: "kind",
          label: "Kind",
          format: "badge",
          width: "6rem",
          labels: { check: "Check", judge: "Judged" },
        },
        { key: "summary", label: "Checks", hiddenBelow: "md" },
        { key: "traces", label: "Traces", width: "9rem", hiddenBelow: "lg" },
        { key: "result", label: "Last 7 days", width: "12rem" },
        {
          key: "status",
          label: "Status",
          format: "badge",
          width: "5rem",
          tones: SWITCH_TONES,
          labels: SWITCH_LABELS,
        },
      ],
      search: ["name", "summary"],
      filters: [
        {
          key: "kind",
          label: "Kind",
          kind: "values",
          badgeLabels: { check: "Check", judge: "Judged" },
        },
        { key: "status", label: "Status", kind: "values", badgeLabels: SWITCH_LABELS },
      ],
      detail: { tool: "get_scorer", args: { scorerId: "id" } },
      empty: {
        title: "No scorers yet",
        description:
          "Ask the agent to create one: a check of each trace, or a question to a judge.",
      },
    },
  },
  {
    tool: "list_alerts",
    config: {
      rows: "alerts",
      rowKey: "id",
      title: "name",
      noun: { one: "alert", many: "alerts" },
      columns: [
        { key: "status", label: "State", format: "badge", width: "8rem", tones: ALERT_TONES },
        { key: "name", label: "Alert" },
        { key: "condition", label: "Condition", hiddenBelow: "md" },
        { key: "lastValueText", label: "Last value", width: "7rem" },
        {
          key: "stateChangedAt",
          label: "Changed",
          format: "relative",
          width: "7rem",
          hiddenBelow: "sm",
        },
      ],
      search: ["name", "condition"],
      filters: [{ key: "status", label: "State", kind: "values" }],
      detail: { tool: "get_alert", args: { alertId: "id" } },
      empty: {
        title: "No alerts yet",
        description: "Ask the agent to watch a metric: it compares one number with a threshold.",
      },
    },
  },
  {
    tool: "list_alert_destinations",
    config: {
      rows: "destinations",
      rowKey: "id",
      title: "name",
      noun: { one: "destination", many: "destinations" },
      columns: [
        { key: "name", label: "Destination" },
        {
          key: "kind",
          label: "Kind",
          format: "badge",
          width: "9rem",
          labels: { webhook: "Webhook", slack_channel: "Slack channel" },
        },
        { key: "warning", label: "Problem", hiddenBelow: "sm" },
      ],
      search: ["name"],
      empty: {
        title: "No destinations yet",
        description: "Ask the agent to add a Slack channel or an incoming webhook.",
      },
    },
  },
  {
    tool: "list_slack_channels",
    config: {
      rows: "channels",
      rowKey: "id",
      title: "name",
      noun: { one: "channel", many: "channels" },
      columns: [
        { key: "name", label: "Channel" },
        { key: "id", label: "ID", format: "id", width: "9rem" },
        {
          key: "isPrivate",
          label: "Access",
          format: "badge",
          width: "7rem",
          labels: { true: "Private", false: "Public" },
        },
      ],
      search: ["name", "id"],
      filters: [{ key: "isPrivate", label: "Private", kind: "flag" }],
      empty: {
        title: "No channels",
        description:
          "An organization admin connects Slack in Settings, Notifications; its channels are listed here.",
      },
    },
  },
  {
    tool: "get_location_attributes",
    config: {
      rows: "rows",
      rowKey: "key",
      title: "holds",
      noun: { one: "location attribute", many: "location attributes" },
      columns: [
        { key: "holds", label: "Holds" },
        { key: "attribute", label: "Span attribute" },
        {
          key: "source",
          label: "Source",
          format: "badge",
          width: "7rem",
          labels: { default: "Default", custom: "Changed" },
          tones: { default: "neutral", custom: "info" },
        },
      ],
      empty: { title: "No location attributes" },
    },
  },
  {
    tool: "list_dashboards",
    config: {
      rows: "dashboards",
      rowKey: "id",
      title: "name",
      noun: { one: "dashboard", many: "dashboards" },
      columns: [
        { key: "name", label: "Dashboard" },
        { key: "widgetCount", label: "Widgets", format: "number", width: "6rem" },
        { key: "updatedBy", label: "Changed by", hiddenBelow: "sm" },
        { key: "updatedAt", label: "Changed", format: "relative", width: "7rem" },
      ],
      search: ["name"],
      empty: {
        title: "No dashboards yet",
        description: "Ask the agent to make one from a description of what it shows.",
      },
    },
  },
];

const view: ViewBindings<ListBinding> = {
  // React DOM (177 KB) plus the DS Panel and Filter menu (base-ui Dialog, Menu,
  // Tooltip and floating-ui, ~150 KB) do not fit the default 490 KB, and both
  // stay (decided on RW-6). Like the default, this is our own guard against
  // size regressions, not a host limit.
  // +70 KB since RW-26: Geist and Geist Mono, inlined in every view (~62 KB of base64).
  // +20 KB since RW-42: views compile the console's own app/globals.css (one stylesheet), ~17 KB more CSS.
  budgetKb: 630,
  title: "List",
  description: "A filterable, sortable list of Ratel records; a row opens its detail.",
  bindings: listBindings,
};

export default view;
