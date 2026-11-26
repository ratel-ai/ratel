import { z } from "zod";
import type { OrgRole } from "@/lib/contracts/session";
import { notFound } from "@/lib/mcp/errors";
import {
  callerAccess,
  callerRole,
  defaultMonitoringDeps,
  type MonitoringCaller,
  type MonitoringDeps,
  observeChange,
  refusal,
  required,
  requireMonitoring,
} from "@/lib/mcp/operations/monitoring/deps";
import { countOf } from "@/lib/mcp/operations/monitoring/results";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { getProjectById } from "@/lib/platform/projects/queries";
import { changeAlert } from "@/lib/views/alerts/actions";
import { changeDestination } from "@/lib/views/alerts/destination-actions";
import {
  createChannelDestination,
  createDestination,
  deleteDestination,
  listDestinations,
  sealedDestination,
} from "@/lib/views/alerts/destinations";
import { conditionText, measuredText, STATE_LABELS, unitOf } from "@/lib/views/alerts/format";
import { alertHref, alertsHref } from "@/lib/views/alerts/links";
import * as store from "@/lib/views/alerts/store";
import {
  ALERT_OPERATORS,
  ALERT_WINDOWS,
  type AlertDestination,
  type AlertRule,
} from "@/lib/views/alerts/types";
import { deploymentOrigin } from "@/lib/views/slack/app";
import { disconnectSlack, readChannels } from "@/lib/views/slack/connection-actions";
import { slackErrorText } from "@/lib/views/slack/errors";
import { deleteSlackConnection, getSlackConnection } from "@/lib/views/slack/store";
import { NOT_ADMIN } from "@/lib/views/slack/types";

/**
 * Alerts and where they go. No result holds a token, a secret or a webhook URL: a destination is
 * read as the pages read it, and a webhook URL passed in is sealed by the action.
 */

const KINDS = { webhook: "Webhook", slack_channel: "Slack channel" } as const;

const alertIdParam = uuidParam().describe("An alert id from list_alerts.");
const destinationIdParam = uuidParam().describe("From list_alert_destinations.");

const ruleShape = z.strictObject({
  name: z.string().max(80),
  query: z
    .record(z.string(), z.unknown())
    .describe(
      'A metric query object without dimensions: describe_monitoring_schema has its schema. Example: {"version":1,"kind":"metric","measures":[{"measure":"error_rate","aggregation":"rate"}]}.',
    ),
  operator: z.enum(ALERT_OPERATORS),
  threshold: z
    .number()
    .nonnegative()
    .describe("In the measure's unit: a rate from 0 to 1, latency in ms, cost in USD."),
  windowMinutes: z.literal(ALERT_WINDOWS),
  destinationIds: z
    .array(uuidParam())
    .max(100)
    .optional()
    .describe("From list_alert_destinations. Empty: it notifies nobody."),
});

export function alertReadOperations(deps: MonitoringDeps = defaultMonitoringDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_alerts",
      domain: "improvement",
      title: "List alerts",
      description:
        "The project's alert rules: each one's condition, state (ok, alerting, no_data), last value, whether it is paused and whether its stored query needs attention. get_alert has one rule's history; change_alert changes it.",
      keywords: ["alerts", "alert rules", "what is alerting"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const rules = await store.listAlertRules(projectId, deps.db());
        const tracker = new TruncationTracker();
        return {
          data: {
            summary: countOf(rules.length, "alert", rules.map(said)),
            count: rules.length,
            alerting: rules.filter(alertsNow).length,
            alerts: tracker.take(capRows(rules, params.limit)).map(listed),
            href: alertsHref(projectId),
          },
          truncated: tracker.value,
          hint:
            rules.length === 0
              ? "No alert yet. change_alert creates one."
              : "get_alert shows one alert's history; query_monitoring reads its numbers.",
        };
      },
    }),
    defineOperation({
      id: "get_alert",
      domain: "improvement",
      title: "Get an alert",
      description:
        "One alert rule: its query, its condition, its state, where its messages go, and its history (each state change with its value, its message and the delivery). Find alert ids with list_alerts.",
      keywords: ["alert history", "alert deliveries", "why did it alert"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, alertId: alertIdParam, limit: limitParam }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const db = deps.db();
        const rule = await store.getAlertRule(projectId, params.alertId, db);
        if (!rule) throw notFound("alert");
        const [events, destinations] = await Promise.all([
          store.listAlertEvents(projectId, rule.id, db, params.limit + 1),
          listDestinations(projectId, db),
        ]);
        const tracker = new TruncationTracker();
        const nameOf = (id: string) => destinations.find((d) => d.id === id)?.name ?? id;
        return {
          data: {
            summary: `${said(rule)}. ${events.length === 0 ? "No state change yet." : `Last change ${events[0].at.toISOString()}: ${STATE_LABELS[events[0].fromState]} to ${STATE_LABELS[events[0].toState]}.`}`,
            alert: {
              ...listed(rule),
              query: rule.query,
              destinations: rule.destinationIds.map((id) => ({ id, name: nameOf(id) })),
            },
            history: tracker.take(capRows(events, params.limit)).map((event) => ({
              at: event.at.toISOString(),
              from: event.fromState,
              to: event.toState,
              value: event.value,
              valueText:
                event.value === null ? null : measuredText(event.value, unitOf(rule.query)),
              condition: conditionText(rule, event),
              message: event.notice,
              delivery: event.delivery,
              sentTo: event.sentTo.map(nameOf),
              error: event.error ? tracker.text(event.error, 300) : null,
            })),
          },
          truncated: tracker.value,
          hint: "change_alert changes it; query_monitoring reads the same query over any window.",
        };
      },
    }),
    defineOperation({
      id: "list_alert_destinations",
      domain: "improvement",
      title: "List alert destinations",
      description:
        "Where the project's alerts can be sent: Slack channels and webhooks, and whether the organization's Slack workspace is connected (with the link to connect it when it is not). Never returns a webhook URL. Change them with change_alert_destination.",
      keywords: ["alert destinations", "slack destinations", "notifications"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const caller = await requireMonitoring(deps, ctx);
        const [destinations, slack] = await Promise.all([
          listDestinations(caller.projectId, deps.db()),
          slackStatus(deps, ctx, caller),
        ]);
        return {
          data: {
            summary: [
              countOf(
                destinations.length,
                "destination",
                destinations.map(({ name, kind }) => `${name} (${KINDS[kind]})`),
              ),
              slack.connected ? `Slack: ${slack.workspace}.` : "Slack is not connected.",
            ].join(" "),
            count: destinations.length,
            destinations: destinations.map(shownDestination),
            slack,
            canStoreWebhooks: deps.canSeal(),
            href: notificationsHref(caller.projectId),
          },
          hint: slack.connected
            ? "list_slack_channels lists the channels; change_alert_destination adds one."
            : connectHint(slack.connectUrl),
        };
      },
    }),
    defineOperation({
      id: "list_slack_channels",
      domain: "improvement",
      title: "List Slack channels",
      description:
        "The Slack channels the connected workspace offers as alert destinations: the public ones, and the private ones the app is in. Without a connection it returns the link an organization admin opens in a browser to connect Slack; a member gets no link.",
      keywords: ["slack channels", "connect slack"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        search: z.string().max(80).optional().describe("Part of the channel's name."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const slack = await slackStatus(deps, ctx, caller);
        if (!slack.connected)
          return {
            data: { summary: "Slack is not connected.", slack, count: 0, channels: [] },
            hint: connectHint(slack.connectUrl),
          };
        const result = await readChannels(caller.projectId, {
          ...callerAccess(ctx, caller),
          list: (organizationId) => deps.slack.listChannels(organizationId),
        });
        if (!result.ok) throw refusal(result.error, "conflict");
        const wanted = params.search?.trim().replace(/^#/, "").toLowerCase() ?? "";
        const channels = result.channels.filter(({ name }) => name.toLowerCase().includes(wanted));
        const tracker = new TruncationTracker();
        tracker.mark(result.partial);
        return {
          data: {
            summary: countOf(
              channels.length,
              "channel",
              channels.map(({ name }) => `#${name}`),
            ),
            slack,
            count: channels.length,
            channels: tracker.take(capRows(channels, params.limit)),
          },
          truncated: tracker.value,
          hint: "Pass a channel's id as channelId to change_alert_destination (action add_channel).",
        };
      },
    }),
  ];
}

export function alertWriteOperations(deps: MonitoringDeps = defaultMonitoringDeps): McpOperation[] {
  return [
    defineOperation({
      id: "change_alert",
      domain: "writes",
      title: "Change an alert",
      description:
        "Create, update, pause, resume or delete an alert rule. A rule compares one metric query with a threshold over a window, with a message when it fires and recovers. A trace counts when it ends, a score when it is stored. A count or a sum of nothing is 0; any other aggregation of nothing is no_data. An update changes only the fields it gives. Read rules with list_alerts.",
      keywords: ["create alert", "pause alert", "edit alert"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum(["create", "update", "pause", "resume", "delete"]),
        alertId: alertIdParam.optional().describe("Every action but create."),
        alert: ruleShape
          .partial()
          .optional()
          .describe(
            'For create (all but destinationIds) and update. Example: {"name":"Errors","query":{…},"operator":"above","threshold":0.05,"windowMinutes":15}.',
          ),
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const db = deps.db();
        const { projectId } = caller;
        const result = await changeAlert(
          { projectId, ...(await changeOf(params, projectId, deps)) },
          {
            ...callerAccess(ctx, caller),
            features: async () => ({ customMonitoring: true }),
            store: {
              createAlertRule: (project, draft, actor) =>
                store.createAlertRule(project, draft, actor, db),
              updateAlertRule: (project, id, draft, actor) =>
                store.updateAlertRule(project, id, draft, actor, db),
              setAlertRuleEnabled: (project, id, enabled, actor) =>
                store.setAlertRuleEnabled(project, id, enabled, actor, db),
              deleteAlertRule: (project, id) => store.deleteAlertRule(project, id, db),
            },
            observe: observeChange(deps, ctx, "feature.alerts.changed"),
          },
        );
        if (!result.ok) throw refusal(result.error);
        const saved = await store.getAlertRule(projectId, result.ruleId, db);
        return {
          data: {
            action: params.action,
            alertId: result.ruleId,
            ...(saved
              ? {
                  alert: { ...listed(saved), query: saved.query },
                  destinationIds: saved.destinationIds,
                }
              : {}),
          },
          hint: saved
            ? "It is evaluated within about a minute. get_alert shows its state and history."
            : "The alert and its history are gone.",
        };
      },
    }),
    defineOperation({
      id: "change_alert_destination",
      domain: "writes",
      title: "Change an alert destination",
      description:
        "Add a Slack channel or an incoming webhook as an alert destination, send a test message to one, delete one, or disconnect the organization's Slack workspace (admins only). A webhook URL is stored sealed and never read back. Find channels with list_slack_channels.",
      keywords: ["add slack channel", "add webhook", "send test alert"],
      scope: "project",
      mutates: true,
      secretParams: ["webhookUrl"],
      params: z.object({
        ...projectScoped,
        action: z.enum(["add_channel", "add_webhook", "send_test", "delete", "disconnect_slack"]),
        channelId: z
          .string()
          .max(30)
          .optional()
          .describe("For add_channel: from list_slack_channels, such as C0123456789."),
        name: z.string().max(200).optional().describe("For add_webhook."),
        webhookUrl: z
          .string()
          .max(1_000)
          .optional()
          .describe("For add_webhook: a secret, https://hooks.slack.com/…"),
        destinationId: destinationIdParam.optional().describe("For send_test and delete."),
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const { action } = params;
        if (action === "disconnect_slack") return disconnect(deps, ctx, caller);
        const db = deps.db();
        const { projectId } = caller;
        const result = await changeDestination(
          { projectId, ...destinationChangeOf({ ...params, action }) },
          {
            ...callerAccess(ctx, caller),
            canSeal: () => deps.canSeal(),
            create: (input) => createDestination({ ...input, key: deps.secretKey }, db),
            channelAccess: (organizationId, channelId) =>
              deps.slack.channelAccess(organizationId, channelId),
            createChannel: (input) => createChannelDestination(input, db),
            remove: (project, id) => deleteDestination(project, id, db),
            sealed: (project, id) => sealedDestination(project, id, db),
            post: (destination, message) => deps.slack.post(destination, message),
            projectName: async (project) => (await getProjectById(project, db))?.name ?? "",
            observe: observeChange(deps, ctx, "feature.alerts.destination_changed"),
          },
        );
        if (!result.ok)
          throw refusal(
            result.error,
            params.action === "send_test" || isSlackState(result.error)
              ? "conflict"
              : "invalid_params",
          );
        const saved = (await listDestinations(projectId, db)).find(
          ({ id }) => id === result.destinationId,
        );
        return {
          data: {
            action: params.action,
            destinationId: result.destinationId,
            ...(saved ? { destination: shownDestination(saved) } : {}),
            ...(result.warning ? { warning: result.warning } : {}),
          },
          hint:
            params.action === "delete"
              ? "Its alerts do not send there any more."
              : "Pass its id in destinationIds to change_alert; send_test checks that it arrives.",
        };
      },
    }),
  ];
}

async function disconnect(deps: MonitoringDeps, ctx: OperationContext, caller: MonitoringCaller) {
  const result = await disconnectSlack(caller.projectId, {
    ...callerAccess(ctx, caller),
    role: async () => callerRole(ctx) as OrgRole | null,
    revoke: (organizationId) => deps.slack.revoke(organizationId),
    remove: (organizationId) => deleteSlackConnection(organizationId, deps.db()),
    observe: observeChange(deps, ctx, "feature.slack.disconnected"),
  });
  if (!result.ok) throw refusal(result.error);
  const slack = await slackStatus(deps, ctx, caller);
  return { data: { action: "disconnect_slack", slack }, hint: `To connect: ${slack.connectUrl}` };
}

type RuleParams = {
  action: "create" | "update" | "pause" | "resume" | "delete";
  alertId?: string;
  alert?: Record<string, unknown>;
};

/** The tool's params as the console's own change. */
async function changeOf(params: RuleParams, projectId: string, deps: MonitoringDeps) {
  const { action } = params;
  if (action === "create") return { action, draft: required(params.alert, "alert", action) };
  const ruleId = required(params.alertId, "alertId", action);
  if (action === "update") {
    const given = required(params.alert, "alert", action);
    const current = await store.getAlertRule(projectId, ruleId, deps.db());
    if (!current) throw notFound("alert");
    const { name, query, operator, threshold, windowMinutes, destinationIds } = current;
    const draft = { name, query, operator, threshold, windowMinutes, destinationIds, ...given };
    return { action, ruleId, draft };
  }
  if (action === "delete") return { action, ruleId };
  return { action: "set_enabled", ruleId, enabled: action === "resume" };
}

function destinationChangeOf(params: {
  action: "add_channel" | "add_webhook" | "send_test" | "delete";
  channelId?: string;
  name?: string;
  webhookUrl?: string;
  destinationId?: string;
}) {
  const { action } = params;
  switch (action) {
    case "add_channel":
      return { action, channelId: required(params.channelId, "channelId", action) };
    case "add_webhook":
      return {
        action: "add",
        name: required(params.name, "name", action),
        url: required(params.webhookUrl, "webhookUrl", action),
      };
    case "send_test":
    case "delete":
      return {
        action: action === "delete" ? "remove" : "test",
        destinationId: required(params.destinationId, "destinationId", action),
      };
  }
}

/** The organization's workspace, and the link a person opens to connect one. */
async function slackStatus(deps: MonitoringDeps, ctx: OperationContext, caller: MonitoringCaller) {
  const [connection, app] = await Promise.all([
    getSlackConnection(caller.organizationId, deps.db(), deps.secretKey),
    deps.slack.appStatus(caller.organizationId),
  ]);
  const connected = connection !== null && !connection.lost;
  return {
    connected,
    workspace: connection?.teamName ?? null,
    lost: connection?.lost ?? false,
    appConfigured: app.kind === "edition" ? app.available : app.clientId !== null,
    // The console refuses a member who opens it. An API key is no person: an admin may open its link.
    ...(connected || callerRole(ctx) === "member"
      ? {}
      : { connectUrl: installUrl(caller.projectId) }),
  };
}

function connectHint(connectUrl: string | undefined): string {
  return connectUrl
    ? `Slack is not connected. An organization admin must open this link in a browser: ${connectUrl}`
    : `Slack is not connected. ${NOT_ADMIN}`;
}

function installUrl(projectId: string): string {
  const query = new URLSearchParams({ projectId });
  return `${deploymentOrigin()}/api/integrations/slack/start?${query}`;
}

function notificationsHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/settings/notifications`;
}

/** A refusal about the workspace's state, not about what the caller passed. */
function isSlackState(error: string): boolean {
  return [
    "not_connected",
    "invalid_auth",
    "missing_scope",
    "ratelimited",
    "timeout",
    "unreachable",
    "bad_answer",
  ].some((code) => slackErrorText(code) === error);
}

function alertsNow(rule: AlertRule): boolean {
  return rule.enabled && rule.problem === null && rule.state === "alerting";
}

function listed(rule: AlertRule) {
  const unit = unitOf(rule.query);
  return {
    id: rule.id,
    name: rule.name,
    condition: conditionText(rule, rule),
    operator: rule.operator,
    threshold: rule.threshold,
    windowMinutes: rule.windowMinutes,
    unit,
    enabled: rule.enabled,
    state: rule.state,
    status: rule.problem ? "Needs attention" : rule.enabled ? STATE_LABELS[rule.state] : "Paused",
    problem: rule.problem,
    lastValue: rule.lastValue,
    lastValueText: rule.lastValue === null ? null : measuredText(rule.lastValue, unit),
    stateChangedAt: rule.stateChangedAt?.toISOString() ?? null,
    destinationCount: rule.destinationIds.length,
    href: alertHref(rule.projectId, rule.id),
  };
}

/** "Errors (Alerting, 7%): Error rate is above 5% over 15 minutes" */
function said(rule: AlertRule): string {
  const { name, status, lastValueText, condition } = listed(rule);
  return `${name} (${lastValueText ? `${status}, ${lastValueText}` : status}): ${condition}`;
}

/** As the Notifications page shows it. */
function shownDestination(destination: AlertDestination) {
  const { id, name } = destination;
  if (destination.kind === "webhook")
    return { id, name, kind: destination.kind, lastFour: destination.lastFour };
  const { kind, channelId, accessError } = destination;
  return { id, name, kind, channelId, warning: accessError ? slackErrorText(accessError) : null };
}
