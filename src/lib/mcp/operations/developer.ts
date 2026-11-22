import { z } from "zod";
import {
  buildQuickstartSet,
  QUICKSTART_CAPTURE_ENV,
  QUICKSTART_CAPTURE_MODE,
  QUICKSTART_KEY_ENV,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
} from "@/lib/console/onboarding/quickstart";
import {
  sdkEventLabel,
  sourceStatusNote,
  summaryVerdict,
  toDropView,
  toRejectView,
  toSdkEventView,
} from "@/lib/console/settings/sdk-events";
import {
  countRuntimeEventRejects,
  countRuntimeEvents,
  getRuntimeEvent,
  listRuntimeEventFacets,
  listRuntimeEventRejects,
  listRuntimeEvents,
  type RuntimeEventClientDropGroup,
  type RuntimeEventFacets,
  type RuntimeEventFilters,
  type RuntimeEventRejectRow,
  type RuntimeEventRow,
  summarizeRuntimeEventClientDrops,
  sumRuntimeEventClientDrops,
} from "@/lib/ingest/runtime-events/queries";
import type { RuntimeEventsRange } from "@/lib/ingest/runtime-events/view";
import { notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, MAX_LIMIT, TruncationTracker } from "@/lib/mcp/serialize";
import { type ApiKeyRecord, toApiKeySummary } from "@/lib/platform/api-key-actions";
import {
  type BoundReadDb,
  readTimeoutMs,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getProjectById, listApiKeysForProject } from "@/lib/platform/projects/queries";
import { publicUrl } from "@/lib/platform/public-url";
import { buildMcpServerGuide } from "@/lib/views/mcp-servers/setup-guide";
import { projectEntitiesEnabledForActor } from "@/lib/views/project-entities/flag";

/**
 * Settings › Developer and Settings › API keys over MCP. Owned: upstream also reads Models ›
 * Tool Picker usage (`get_tool_picker_usage`); the Tool Picker and its ledger stay private.
 *
 * Every read is the one those pages make: the SDK event reads from
 * `lib/runtime-events/queries.ts` shaped by `lib/settings/v2/sdk-events.ts`,
 * the key list through `toApiKeySummary` (no hash, no plaintext), the
 * quickstart from `lib/quickstart.ts`. As on the Developer page, the counts
 * and facets run under the short supplementary statement timeout and degrade
 * to null on their own, while the list itself runs under the normal one and a
 * timeout there is reported as such. An event's payload, and a subject that is
 * an end user's search, are captured text (`mayReadContent`).
 */

type WindowFilters = Pick<RuntimeEventFilters, "sourceId" | "since" | "until">;
type ListFilters = WindowFilters & Pick<RuntimeEventFilters, "type" | "limit">;

export interface DeveloperOperationDeps extends ContentAccessDeps {
  countRuntimeEvents: (projectId: string, filters: WindowFilters) => Promise<number>;
  sumRuntimeEventClientDrops: (projectId: string, filters: WindowFilters) => Promise<number>;
  countRuntimeEventRejects: (projectId: string, filters: WindowFilters) => Promise<number>;
  listRuntimeEvents: (projectId: string, filters: ListFilters) => Promise<RuntimeEventRow[]>;
  listRuntimeEventRejects: (
    projectId: string,
    filters: ListFilters,
  ) => Promise<RuntimeEventRejectRow[]>;
  summarizeRuntimeEventClientDrops: (
    projectId: string,
    filters: WindowFilters & { limit?: number },
  ) => Promise<RuntimeEventClientDropGroup[]>;
  listRuntimeEventFacets: (projectId: string) => Promise<RuntimeEventFacets>;
  getRuntimeEvent: (projectId: string, identifier: string) => Promise<RuntimeEventRow | null>;
  listApiKeysForProject: (projectId: string) => Promise<ApiKeyRecord[]>;
  getProject: (projectId: string) => Promise<{ id: string; slug: string } | null>;
  publicUrl: (path: string) => string;
  /** `FF_AGENTS_PAGES` for the caller: on, get_sdk_setup also returns the MCP server guide (RC-780). */
  projectEntitiesEnabled: (projectId: string, actor: string) => Promise<boolean>;
  now: () => Date;
}

/** A read under the statement timeout the Developer page gives it. */
function bounded<T>(
  operation: string,
  timeoutMs: number | null,
  load: (db: BoundReadDb) => Promise<T>,
): Promise<T> {
  return withStatementTimeout(load, { operation, timeoutMs });
}

export const defaultDeveloperDeps: DeveloperOperationDeps = {
  countRuntimeEvents: (projectId, filters) =>
    bounded("mcp_sdk_events_received", supplementaryReadTimeoutMs(), (db) =>
      countRuntimeEvents(projectId, filters, db),
    ),
  sumRuntimeEventClientDrops: (projectId, filters) =>
    bounded("mcp_sdk_events_dropped", supplementaryReadTimeoutMs(), (db) =>
      sumRuntimeEventClientDrops(projectId, filters, db),
    ),
  countRuntimeEventRejects: (projectId, filters) =>
    bounded("mcp_sdk_events_rejected", supplementaryReadTimeoutMs(), (db) =>
      countRuntimeEventRejects(projectId, filters, db),
    ),
  listRuntimeEvents: (projectId, filters) =>
    bounded("mcp_sdk_events_list", readTimeoutMs(), (db) =>
      listRuntimeEvents(projectId, filters, db),
    ),
  listRuntimeEventRejects: (projectId, filters) =>
    bounded("mcp_sdk_events_rejects", readTimeoutMs(), (db) =>
      listRuntimeEventRejects(projectId, filters, db),
    ),
  summarizeRuntimeEventClientDrops: (projectId, filters) =>
    bounded("mcp_sdk_events_drop_groups", readTimeoutMs(), (db) =>
      summarizeRuntimeEventClientDrops(projectId, filters, db),
    ),
  listRuntimeEventFacets: (projectId) =>
    bounded("mcp_sdk_events_facets", supplementaryReadTimeoutMs(), (db) =>
      listRuntimeEventFacets(projectId, {}, db),
    ),
  getRuntimeEvent: (projectId, identifier) =>
    bounded("mcp_sdk_event", supplementaryReadTimeoutMs(), (db) =>
      getRuntimeEvent(projectId, identifier, db),
    ),
  listApiKeysForProject: (projectId) => listApiKeysForProject(projectId),
  getProject: (projectId) => getProjectById(projectId),
  publicUrl,
  // The core's FF_AGENTS_PAGES switch (upstream's cloud-project-entities flag service).
  projectEntitiesEnabled: (projectId, actor) => projectEntitiesEnabledForActor(projectId, actor),
  now: () => new Date(),
  contentOptIn: readContentOptIn,
};

const RANGE_DAYS: Record<RuntimeEventsRange, number> = { "24h": 1, "7d": 7, "30d": 30 };
const DAY_MS = 86_400_000;

/** Payload text carried by get_sdk_event before it says it was cut. */
export const SDK_EVENT_PAYLOAD_CHARS = 4_000;
const SUBJECT_CHARS = 200;
const ERROR_CHARS = 300;
const FACET_TYPES = 50;
const FACET_SOURCES = 25;

/** Read one supplementary number; a failure costs that number, not the answer (the page's rule). */
async function orNull<T>(
  ctx: OperationContext,
  operation: string,
  load: () => Promise<T>,
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    ctx.logger.warn({ err: error, operation }, "mcp supplementary read failed");
    return null;
  }
}

function summarizeEvent(row: RuntimeEventRow, tracker: TruncationTracker, content: boolean) {
  // The trace root only builds console links, which an agent cannot follow; the ids are kept instead.
  const view = toSdkEventView(row, "");
  // A search event's subject is its query: an end user's words.
  const subject = !content && row.query ? null : view.subject;
  return {
    identifier: view.identifier,
    type: view.type,
    label: view.label,
    subject: subject === null ? null : tracker.text(subject, SUBJECT_CHARS),
    source: view.source,
    sourceStatus: view.sourceStatus,
    at: view.at,
    receivedAt: view.receivedAt,
    durationMs: view.durationMs,
    error: view.error === null ? null : tracker.text(view.error, ERROR_CHARS),
    traceId: view.ids.trace,
    spanId: view.ids.span,
    invocationId: view.ids.invocation,
    values: view.values,
  };
}

function summarizeReject(row: RuntimeEventRejectRow) {
  const { key: _key, ...view } = toRejectView(row);
  return view;
}

function summarizeDrop(group: RuntimeEventClientDropGroup) {
  const { key: _key, ...view } = toDropView(group);
  return view;
}

function summarizeFacets(facets: RuntimeEventFacets | null, tracker: TruncationTracker) {
  if (!facets) return null;
  return {
    types: tracker
      .take(capRows(facets.types, FACET_TYPES))
      .map((type) => ({ type, label: sdkEventLabel(type) })),
    sources: tracker.take(capRows(facets.sources, FACET_SOURCES)).map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      note: sourceStatusNote(source.status),
      lastSeenAt: source.lastSeenAt.toISOString(),
    })),
  };
}

export function developerOperations(
  deps: DeveloperOperationDeps = defaultDeveloperDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_sdk_events",
      domain: "observability",
      title: "SDK events",
      description:
        "What Settings › Developer shows: SDK events received over 24h, 7d or 30d with received, dropped and rejected counts, type and source facets, and the newest rows. view rejects lists events Ratel refused (reason, size); view drops lists what the SDK dropped before sending. get_sdk_event returns one event's payload.",
      keywords: [
        "sdk events",
        "runtime events",
        "rejected events",
        "dropped events",
        "developer",
        "ingest",
        "sdk not sending",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        range: z
          .enum(["24h", "7d", "30d"])
          .default("7d")
          .describe("The window, as on the Developer page."),
        view: z
          .enum(["events", "rejects", "drops"])
          .default("events")
          .describe(
            "events: what arrived. rejects: what Ratel refused. drops: what the SDK reported dropping.",
          ),
        type: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Only this event type, e.g. invoke_error. See facets.types."),
        sourceId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Only this SDK source. See facets.sources."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const until = deps.now();
        const since = new Date(until.getTime() - RANGE_DAYS[params.range] * DAY_MS);
        // The summary answers for the window (and source); the lists also honor the type filter.
        const windowFilters: WindowFilters = { sourceId: params.sourceId, since, until };
        const listFilters: ListFilters = {
          ...windowFilters,
          type: params.type,
          limit: params.limit + 1,
        };

        const [received, dropped, rejected, facets, rows] = await Promise.all([
          orNull(ctx, "sdk_events_received", () =>
            deps.countRuntimeEvents(ctx.projectId, windowFilters),
          ),
          orNull(ctx, "sdk_events_dropped", () =>
            deps.sumRuntimeEventClientDrops(ctx.projectId, windowFilters),
          ),
          orNull(ctx, "sdk_events_rejected", () =>
            deps.countRuntimeEventRejects(ctx.projectId, windowFilters),
          ),
          orNull(ctx, "sdk_events_facets", () => deps.listRuntimeEventFacets(ctx.projectId)),
          params.view === "events"
            ? deps.listRuntimeEvents(ctx.projectId, listFilters).then((list) => ({ events: list }))
            : params.view === "rejects"
              ? deps
                  .listRuntimeEventRejects(ctx.projectId, listFilters)
                  .then((list) => ({ rejects: list }))
              : deps
                  .summarizeRuntimeEventClientDrops(ctx.projectId, {
                    ...windowFilters,
                    limit: params.limit + 1,
                  })
                  .then((list) => ({ drops: list })),
        ]);

        const activeSources = facets
          ? facets.sources.filter((source) => source.status === "active").length
          : null;
        const summary = { received, dropped, rejected, activeSources };
        const verdict = summaryVerdict({
          received,
          dropped,
          rejected,
          sources: activeSources ?? 0,
        });

        const content =
          "events" in rows && rows.events.some((row) => row.query)
            ? await mayReadContent(ctx, deps)
            : true;
        const list =
          "events" in rows
            ? {
                events: tracker
                  .take(capRows(rows.events, params.limit))
                  .map((row) => summarizeEvent(row, tracker, content)),
              }
            : "rejects" in rows
              ? { rejects: tracker.take(capRows(rows.rejects, params.limit)).map(summarizeReject) }
              : { drops: tracker.take(capRows(rows.drops, params.limit)).map(summarizeDrop) };

        return {
          data: {
            view: params.view,
            range: params.range,
            summary,
            verdict: verdict?.text ?? null,
            facets: summarizeFacets(facets, tracker),
            ...list,
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          window: { since: since.toISOString(), until: until.toISOString() },
          hint: contentHint(
            content,
            params.view === "events"
              ? "Rows are newest first. get_sdk_event with an identifier returns its payload; get_trace takes a traceId."
              : "Rejects and drops never became events. Fix the reason given, then check view events again.",
          ),
        };
      },
    }),
    defineOperation({
      id: "get_sdk_event",
      domain: "observability",
      title: "SDK event payload",
      description:
        "One SDK event as Settings › Developer opens it: its type, source, timing, ids and the payload exactly as the SDK sent it, cut at 4000 characters. Take the identifier from list_sdk_events.",
      keywords: ["sdk event", "payload", "runtime event", "event detail"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        identifier: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .describe(
            "The event's identifier from list_sdk_events: the SDK's event id, or the stored row id.",
          ),
      }),
      async execute(ctx, params) {
        const row = await deps.getRuntimeEvent(ctx.projectId, params.identifier);
        if (!row) throw notFound("SDK event");
        const content = await mayReadContent(ctx, deps);
        const tracker = new TruncationTracker();
        const json = JSON.stringify(row.payload ?? {});
        return {
          data: {
            event: summarizeEvent(row, tracker, content),
            // The payload is the SDK's as sent: queries, arguments and results included.
            payload: content ? tracker.text(json, SDK_EVENT_PAYLOAD_CHARS) : null,
            payloadChars: json.length,
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            tracker.value
              ? "The payload was cut; the full one is in Settings › Developer."
              : undefined,
          ),
        };
      },
    }),
    defineOperation({
      id: "list_api_keys",
      domain: "account",
      title: "API keys",
      description:
        "The project's API keys as Settings › API keys lists them: name, prefix, access (full, read_only, ingest or custom, with its scopes; publishable keys are safe to ship in an app), status, created, last used and expiry. Never the key itself. Keys are created and revoked in the console; get_sdk_setup shows how to use one.",
      keywords: ["api keys", "keys", "credentials", "expired key", "last used", "rtl_"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const now = deps.now();
        const keys = await deps.listApiKeysForProject(ctx.projectId);
        const tracker = new TruncationTracker();
        const page = tracker.take(capRows(keys, MAX_LIMIT));
        const callerKeyId = ctx.auth.kind === "api-key" ? ctx.auth.apiKeyId : null;
        return {
          data: {
            count: page.length,
            keys: page.map((key) => {
              // toApiKeySummary is the allowlist: id, name, prefix, access, dates, status. No hash or plaintext.
              const summary = toApiKeySummary(key, now);
              return {
                id: summary.id,
                name: summary.name,
                keyPrefix: summary.keyPrefix,
                access: summary.access,
                scopes: summary.scopes,
                publishable: summary.publishable,
                status: summary.status,
                createdAt: summary.createdAt,
                lastUsedAt: summary.lastUsedAt,
                expiresAt: summary.expiresAt,
                usedByThisSession: summary.id === callerKeyId,
              };
            }),
          },
          truncated: tracker.value,
        };
      },
    }),
    defineOperation({
      id: "get_sdk_setup",
      domain: "account",
      title: "SDK setup",
      description:
        "The quickstart Settings › API keys shows: the traces endpoint, the key's env var, the install line and a snippet per language (TypeScript, curl). With the MCP servers page on, mcpServer adds the guide to trace an MCP server with standard OpenTelemetry. captureContent adds the content capture lines. No key is inlined; list_api_keys lists the project's keys.",
      keywords: [
        "setup",
        "quickstart",
        "install sdk",
        "send traces",
        "endpoint",
        "snippet",
        "onboarding",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        captureContent: z
          .boolean()
          .default(false)
          .describe(
            "Include the opt-in lines that send search queries and tool arguments on spans.",
          ),
      }),
      async execute(ctx, params) {
        const project = await deps.getProject(ctx.projectId);
        if (!project) throw notFound("project");
        const endpoint = deps.publicUrl("/v1/traces");
        const snippets = buildQuickstartSet({
          endpoint,
          serviceName: project.slug,
          captureContent: params.captureContent,
        });
        const mcpServer = (await deps.projectEntitiesEnabled(
          ctx.projectId,
          mcpActor(ctx.auth, ctx.projectId),
        ))
          ? buildMcpServerGuide({ tracesEndpoint: endpoint, serviceName: "my-mcp-server" })
          : null;
        return {
          data: {
            endpoint,
            serviceName: project.slug,
            keyEnvVar: QUICKSTART_KEY_ENV,
            ...(params.captureContent
              ? {
                  contentCapture: {
                    envVar: QUICKSTART_CAPTURE_ENV,
                    value: QUICKSTART_CAPTURE_MODE,
                  },
                }
              : {}),
            snippets: QUICKSTART_LANGS.map((lang) => ({
              lang,
              label: QUICKSTART_LANG_LABELS[lang],
              install: snippets[lang].install,
              code: snippets[lang].code,
            })),
            ...(mcpServer ? { mcpServer } : {}),
          },
          hint: `Set ${QUICKSTART_KEY_ENV} to a key from Settings › API keys. After the first send, list_sdk_events and get_traces_ingest_diagnostics confirm it arrived.`,
        };
      },
    }),
  ];
}
