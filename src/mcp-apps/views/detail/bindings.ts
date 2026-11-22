import type { McpAppBinding } from "@/lib/mcp/apps/types";
import type { DetailConfig } from "../../shell/config";
import type { ViewBindings } from "../../shell/types";
import {
  EVIDENCE_LABELS,
  EVIDENCE_TONES,
  SKILL_LABELS,
  SKILL_TONES,
  TASK_LABELS,
  TASK_TONES,
} from "../list/bindings";

export type DetailBinding = McpAppBinding & { config: DetailConfig };

/**
 * One entity: its key facts, then sections. The list view's Panel renders a
 * row's detail tool with these same bindings. get_trace keeps its config here
 * for that Panel, but opens in its own view (views/trace: the console's
 * TraceView).
 */
export const detailBindings: DetailBinding[] = [
  {
    tool: "get_trace",
    config: {
      root: "",
      title: "traceId",
      noun: "flow",
      fields: [
        { key: "traceId", label: "Trace", format: "id" },
        { key: "spanCount", label: "Spans", format: "number" },
      ],
      sections: [
        {
          title: "Spans",
          kind: "table",
          key: "spans",
          columns: [
            { key: "name", label: "Span" },
            { key: "toolName", label: "Tool", format: "entity", noun: "tool", hiddenBelow: "md" },
            {
              key: "statusCode",
              label: "Status",
              format: "badge",
              width: "5.5rem",
              tones: { "0": "neutral", "1": "success", "2": "danger" },
              labels: { "0": "Unset", "1": "OK", "2": "Error" },
            },
            { key: "durationMs", label: "Duration", format: "duration", width: "6rem" },
            { key: "costUsd", label: "Cost", format: "currency", width: "6rem", hiddenBelow: "sm" },
          ],
        },
      ],
    },
  },
  {
    tool: "get_intent",
    config: {
      root: "intent",
      title: "name",
      noun: "intent",
      href: "intent.href",
      fields: [
        { key: "description", label: "About", content: true },
        { key: "turns", label: "Turns", format: "number" },
        // components/intents/v2/TopicPanel.tsx prints these three as whole percents.
        { key: "share", label: "Share", format: "whole" },
        { key: "answeredShare", label: "Answered", format: "whole" },
        { key: "sentiment.negativeShare", label: "Negative", format: "whole" },
        { key: "selfCorrections", label: "Self-corrections", format: "number" },
        { key: "askedAgain", label: "Asked again", format: "number" },
      ],
      sections: [
        {
          title: "Tasks",
          kind: "table",
          key: "tasks",
          columns: [
            { key: "name", label: "Task", format: "entity", noun: "task" },
            { key: "turns", label: "Turns", format: "number", width: "5rem" },
            { key: "share", label: "Share", format: "bar", unit: "percent", width: "9rem" },
          ],
        },
        {
          title: "Tools",
          kind: "table",
          key: "tools",
          columns: [
            { key: "id", label: "Tool", format: "entity", noun: "tool" },
            { key: "calls", label: "Calls", format: "number", width: "5rem" },
            { key: "failureShare", label: "Failing", format: "percent", width: "5rem" },
          ],
        },
        { title: "Example asks", kind: "list", key: "exampleAsks" },
      ],
    },
  },
  {
    // components/tasks/TaskView.tsx: its stat row, then steps, issues, fixes and example runs.
    tool: "get_task",
    config: {
      root: "task",
      title: "name",
      noun: "task",
      href: "task.href",
      fields: [
        { key: "description", label: "About" },
        { key: "status", label: "Status", format: "badge", tones: TASK_TONES, labels: TASK_LABELS },
        { key: "statusLine", label: "Reading" },
        { key: "runs", label: "Runs", format: "number" },
        { key: "share", label: "Share of runs", format: "share" },
        { key: "finishRate", label: "Finish rate", format: "share" },
        { key: "medianMs", label: "Typical run", format: "duration" },
        { key: "callsPerRun", label: "Calls per run", format: "number" },
        { key: "correctionsPer100", label: "Self-corrections per 100 runs", format: "per100" },
        { key: "cost", label: "Cost per run", format: "taskCost" },
      ],
      sections: [
        {
          title: "Steps",
          kind: "table",
          key: "steps",
          columns: [
            { key: "label", label: "Step", format: "entity", noun: "tool" },
            { key: "runShare", label: "In runs", format: "share", width: "5.5rem" },
            { key: "failureShare", label: "Failing", format: "share", width: "5rem" },
            {
              key: "medianMs",
              label: "Median",
              format: "duration",
              width: "5.5rem",
              hiddenBelow: "sm",
            },
          ],
        },
        {
          title: "Issues",
          kind: "table",
          key: "issueList",
          columns: [
            { key: "title", label: "Issue", format: "entity", noun: "issue" },
            { key: "figure.display", label: "Measure", width: "5.5rem", align: "right" },
          ],
        },
        {
          title: "Fixes",
          kind: "table",
          key: "fixList",
          columns: [
            { key: "title", label: "Fix", format: "entity", noun: "fix" },
            { key: "kindLabel", label: "Kind", width: "8rem", hiddenBelow: "sm" },
          ],
        },
        {
          title: "Example runs",
          kind: "table",
          key: "exampleRuns",
          columns: [
            {
              key: "why",
              label: "Why",
              format: "badge",
              width: "5rem",
              tones: { failed: "danger", slow: "warning", recent: "neutral" },
              labels: { failed: "Failed", slow: "Slow", recent: "Recent" },
            },
            { key: "ask", label: "Ask", content: true },
            {
              key: "startedAt",
              label: "Started",
              format: "date",
              width: "6.5rem",
              hiddenBelow: "sm",
            },
          ],
        },
      ],
    },
  },
  {
    // The fix panel (components/fixes/v2/FixDetail.tsx): kind, effect, evidence, then where it
    // came from, the change, its issues, experiments and shipments.
    tool: "get_fix",
    config: {
      root: "fix",
      title: "title",
      noun: "fix",
      href: "fix.href",
      fields: [
        { key: "kindLabel", label: "Kind" },
        {
          key: "status",
          label: "Status",
          format: "badge",
          tones: { open: "neutral", applied: "success" },
          labels: { open: "Open", applied: "Applied" },
        },
        { key: "why", label: "Why" },
        { key: "effect.value", label: "Effect" },
        {
          key: "evidence.strength",
          label: "Evidence",
          format: "badge",
          tones: EVIDENCE_TONES,
          labels: EVIDENCE_LABELS,
        },
        { key: "evidence.detail", label: "Based on" },
        { key: "appliedAt", label: "Applied", format: "date" },
      ],
      sections: [
        { title: "Change", kind: "list", key: "change.steps" },
        {
          title: "Where it came from",
          kind: "table",
          key: "chain",
          columns: [
            {
              key: "stage",
              label: "Stage",
              format: "badge",
              width: "6rem",
              labels: {
                monitor: "Monitor",
                insights: "Insights",
                improve: "Improve",
                ship: "Ship",
              },
            },
            { key: "label", label: "Step" },
          ],
        },
        {
          title: "Issues",
          kind: "table",
          key: "issues",
          columns: [
            { key: "title", label: "Issue", format: "entity", noun: "issue" },
            { key: "claim", label: "Claim", hiddenBelow: "sm" },
          ],
        },
        {
          title: "Experiments",
          kind: "table",
          key: "experiments",
          columns: [
            { key: "name", label: "Experiment" },
            {
              key: "status",
              label: "Status",
              format: "badge",
              width: "5.5rem",
              tones: { running: "info", stopped: "neutral" },
              labels: { running: "Running", stopped: "Stopped" },
            },
            { key: "trafficPercent", label: "Traffic %", format: "number", width: "5rem" },
          ],
        },
        {
          title: "Shipments",
          kind: "table",
          key: "shipments",
          columns: [
            { key: "version", label: "Version", format: "number", width: "5rem" },
            { key: "notes", label: "Notes" },
            { key: "shippedAt", label: "Shipped", format: "date", width: "6.5rem" },
          ],
        },
      ],
    },
  },
  {
    // The catalog's item panel (components/catalog/v2/CatalogItemDetail.tsx).
    tool: "get_skill",
    config: {
      root: "skill",
      title: "name",
      noun: "skill",
      fields: [
        { key: "description", label: "Description" },
        { key: "searchableDescription", label: "Searchable description" },
        {
          key: "status",
          label: "Status",
          format: "badge",
          tones: SKILL_TONES,
          labels: SKILL_LABELS,
        },
        { key: "version", label: "Version", format: "number" },
        { key: "model", label: "Model" },
        { key: "updatedAt", label: "Updated", format: "date" },
        { key: "publishedAt", label: "Published", format: "date" },
        { key: "body", label: "Instructions" },
      ],
      sections: [
        { title: "Tools", kind: "list", key: "tools" },
        { title: "Tags", kind: "list", key: "tags" },
      ],
    },
  },
  {
    // The SDK event panel (components/settings/v2/SdkEventPanel.tsx), in its order. The payload
    // stays in the tool's text answer.
    tool: "get_sdk_event",
    config: {
      root: "event",
      title: "label",
      subtitle: "identifier",
      fields: [
        { key: "error", label: "Error" },
        { key: "type", label: "Type" },
        { key: "subject", label: "About", content: true },
        { key: "source", label: "Source" },
        { key: "identifier", label: "Event ID", format: "id" },
        { key: "traceId", label: "Trace ID", format: "id" },
        { key: "spanId", label: "Span ID", format: "id" },
        { key: "receivedAt", label: "Received", format: "date" },
        { key: "durationMs", label: "Duration", format: "duration" },
        { key: "values.hits", label: "Results", format: "number" },
        { key: "values.topK", label: "Asked for", format: "number" },
        { key: "values.inputTokens", label: "Input tokens", format: "number" },
        { key: "values.outputTokens", label: "Output tokens", format: "number" },
      ],
    },
  },
  {
    // The project's overview header: whether data arrives, and what it holds.
    tool: "get_project_overview",
    config: {
      root: "",
      title: "project.name",
      consolePath: "/project/{project.id}",
      fields: [
        { key: "project.slug", label: "Service name" },
        {
          key: "hasIngestedTelemetry",
          label: "Telemetry",
          format: "badge",
          tones: { true: "success", false: "neutral" },
          labels: { true: "Receiving data", false: "No data yet" },
        },
        { key: "counts.skills", label: "Skills", format: "number" },
        { key: "counts.activeExperiments", label: "Active experiments", format: "number" },
      ],
    },
  },
];

const view: ViewBindings<DetailBinding> = {
  title: "Detail",
  description: "One Ratel item: its facts, then its lists, as the console's panel shows it.",
  bindings: detailBindings.filter((binding) => binding.tool !== "get_trace"),
};

export default view;
