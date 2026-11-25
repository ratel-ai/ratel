/**
 * Web and MCP parity: each console action of these modules, and the MCP operation that does the
 * same. `parity.test.ts` finds the actions in the source and fails for one that is not here, so a
 * new console action needs an operation (or a reason why a browser must do it).
 */

/** An operation's id, or why there is none. */
export type Covered = string | { none: string };

/** Where the modules' actions are: every exported function of these files is one. */
export const ACTION_FILES = {
  scorers: ["lib/views/scorers/*actions.ts", "lib/views/scorers/preview.ts"],
  alerts: ["lib/views/alerts/*actions.ts", "lib/views/alerts/preview.ts"],
  dashboards: [
    "lib/views/dashboards/*actions.ts",
    "lib/views/dashboards/data.ts",
    "lib/views/dashboards/document.ts",
  ],
  slack: ["lib/views/slack/*actions.ts", "lib/views/slack/install.ts"],
  locations: ["lib/ingest/geo/actions.ts"],
  console: [
    "app/(console)/project/[projectId]/scorers/*actions.ts",
    "app/(console)/project/[projectId]/alerts/*actions.ts",
    "app/(console)/project/[projectId]/dashboards/*actions.ts",
    "app/(console)/project/[projectId]/overview-actions.ts",
    "app/(console)/project/[projectId]/settings/geo-actions.ts",
    "app/(console)/project/[projectId]/settings/notifications/*actions.ts",
    "app/(console)/org/[orgSlug]/settings/slack/*actions.ts",
  ],
} as const;

const CHECK: Covered = { none: "the access check the actions share; dispatch does it here" };
const CLIENT_SECRET: Covered = {
  none: "it takes the Slack app's client secret, which a person types in the browser",
};
const CONSENT: Covered = {
  none: "Slack's consent needs a browser; list_slack_channels returns the link",
};

export const PARITY: Readonly<Record<string, Covered>> = {
  "lib/views/scorers/actions.ts#changeScorer": "change_scorer",
  "lib/views/scorers/actions.ts#testScorer": "test_scorer",
  "lib/views/scorers/actions.ts#authorizeScorers": CHECK,
  "lib/views/scorers/preview.ts#previewScorer": "test_scorer",
  "lib/views/scorers/preview.ts#countLastWeek": "test_scorer",
  "lib/views/alerts/actions.ts#changeAlert": "change_alert",
  "lib/views/alerts/actions.ts#authorizeAlerts": CHECK,
  "lib/views/alerts/destination-actions.ts#changeDestination": "change_alert_destination",
  "lib/views/alerts/preview.ts#loadAlertPreview": "query_monitoring",
  "lib/views/dashboards/actions.ts#changeDashboard": "change_dashboard",
  "lib/views/dashboards/data.ts#loadWidget": "query_monitoring",
  "lib/views/dashboards/data.ts#loadWidgets": "get_dashboard",
  "lib/views/dashboards/document.ts#exportDashboard": "get_dashboard",
  "lib/views/dashboards/document.ts#importDashboard": "import_dashboard",
  "lib/views/slack/connection-actions.ts#readChannels": "list_slack_channels",
  "lib/views/slack/connection-actions.ts#disconnectSlack": "change_alert_destination",
  "lib/views/slack/app-actions.ts#changeSlackApp": CLIENT_SECRET,
  "lib/views/slack/app-actions.ts#slackAppAdmin": CHECK,
  "lib/views/slack/install.ts#startInstall": CONSENT,
  "lib/views/slack/install.ts#finishInstall": CONSENT,

  "lib/ingest/geo/actions.ts#changeGeoAttributes": "change_location_attributes",

  "app/(console)/project/[projectId]/settings/geo-actions.ts#saveGeoAttributesAction":
    "change_location_attributes",
  "app/(console)/project/[projectId]/scorers/actions.ts#changeScorerAction": "change_scorer",
  "app/(console)/project/[projectId]/scorers/actions.ts#testScorerAction": "test_scorer",
  "app/(console)/project/[projectId]/scorers/actions.ts#countScorerTracesAction": "test_scorer",
  "app/(console)/project/[projectId]/alerts/actions.ts#changeAlertAction": "change_alert",
  "app/(console)/project/[projectId]/alerts/actions.ts#changeDestinationAction":
    "change_alert_destination",
  "app/(console)/project/[projectId]/alerts/actions.ts#previewAlertAction": "query_monitoring",
  "app/(console)/project/[projectId]/dashboards/actions.ts#changeDashboardAction":
    "change_dashboard",
  "app/(console)/project/[projectId]/dashboards/actions.ts#exportDashboardAction": "get_dashboard",
  "app/(console)/project/[projectId]/dashboards/actions.ts#previewWidgetAction": "query_monitoring",
  "app/(console)/project/[projectId]/settings/notifications/actions.ts#slackChannelsAction":
    "list_slack_channels",
  "app/(console)/project/[projectId]/settings/notifications/actions.ts#disconnectSlackAction":
    "change_alert_destination",
  "app/(console)/project/[projectId]/overview-actions.ts#saveOverviewLayout":
    "change_overview_layout",
  "app/(console)/project/[projectId]/overview-actions.ts#addDashboardWidgetToOverview":
    "change_overview_layout",
  "app/(console)/project/[projectId]/overview-actions.ts#loadOverviewDashboardWidgets":
    "get_dashboard",
  "app/(console)/project/[projectId]/overview-actions.ts#undoOverviewLayout":
    "undo_overview_change",
  "app/(console)/project/[projectId]/overview-actions.ts#restoreOverviewLayoutEntry":
    "restore_overview_layout",
  "app/(console)/project/[projectId]/overview-actions.ts#loadOverviewHistory":
    "list_overview_changes",
  "app/(console)/org/[orgSlug]/settings/slack/actions.ts#changeSlackAppAction": CLIENT_SECRET,
};

/** Each change a module's action takes (its `action: "…"`), and the operation's own `action`, or the operation it is alone. */
export const CHANGES: Readonly<
  Record<
    string,
    { operation: string; actions: Readonly<Record<string, string | { operation: string }>> }
  >
> = {
  "lib/views/scorers/actions.ts": {
    operation: "change_scorer",
    actions: {
      create: "create",
      update: "update",
      set_enabled: "enable",
      delete: "delete",
      attach: "attach",
      detach: "detach",
    },
  },
  "lib/views/alerts/actions.ts": {
    operation: "change_alert",
    actions: { create: "create", update: "update", set_enabled: "pause", delete: "delete" },
  },
  "lib/views/alerts/destination-actions.ts": {
    operation: "change_alert_destination",
    actions: {
      add: "add_webhook",
      add_channel: "add_channel",
      test: "send_test",
      remove: "delete",
    },
  },
  "lib/views/dashboards/actions.ts": {
    operation: "change_dashboard",
    actions: {
      create: "create",
      "create-starter": "create_starter",
      import: { operation: "import_dashboard" },
      rename: "rename",
      delete: "delete",
      "save-defaults": "set_filters",
      "add-widget": "add_widget",
      "edit-widget": "change_widget",
      "save-layout": "move_widgets",
      "remove-widget": "remove_widget",
    },
  },
};

/**
 * What a person does in Explore, which stores nothing, and the operation that does the same with
 * the same query object. `change` is the operation's own `action`.
 */
export const EXPLORE: Readonly<Record<string, { operation: string; change?: string }>> = {
  "run a panel": { operation: "query_monitoring" },
  "show two to four panels": { operation: "query_monitoring" },
  "share the page (the result's href)": { operation: "query_monitoring" },
  "open a widget or a trace filter in Explore": { operation: "query_monitoring" },
  "save a panel to a new dashboard": { operation: "change_dashboard", change: "create" },
  "save a panel to a dashboard": { operation: "change_dashboard", change: "add_widget" },
  "create an alert from a panel": { operation: "change_alert", change: "create" },
  "view the traces of a panel": { operation: "list_traces" },
};

/** Where the page makes its changes and its reads. */
export const EXPLORE_FILES = [
  "components/console/explore/ExploreView.tsx",
  "components/console/explore/ExplorePanel.tsx",
  "components/console/explore/SaveToDashboard.tsx",
  "components/console/explore/use-explore-panels.ts",
  "components/console/dashboards/use-widget-preview.ts",
] as const;

/** The functions a source file exports. */
export function exportedFunctions(source: string): string[] {
  const declared = source.matchAll(/^export (?:async )?function (\w+)/gm);
  const assigned = source.matchAll(/^export const (\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/gm);
  return [...declared, ...assigned].map(([, name]) => name);
}

/** The changes a source file's action takes. */
export function takenChanges(source: string): string[] {
  return [...new Set([...source.matchAll(/\{\s*action: "([\w-]+)"/g)].map(([, name]) => name))];
}

/** The server actions a source file imports. */
export function importedActions(source: string): string[] {
  return [...source.matchAll(/import \{([^}]*)\} from "@\/app\/[^"]*actions"/g)].flatMap(
    ([, names]) => [...names.matchAll(/(\w+Action)\b/g)].map(([, name]) => name),
  );
}

/** What is wrong: an action without an entry, or an entry whose operation does not exist. */
export function parityProblems(
  actions: readonly string[],
  operationIds: ReadonlySet<string>,
  parity: Readonly<Record<string, Covered>> = PARITY,
): string[] {
  const missing = actions
    .filter((action) => parity[action] === undefined)
    .map((action) => `${action} has no MCP operation`);
  const stale = Object.keys(parity)
    .filter((action) => !actions.includes(action))
    .map((action) => `${action} does not exist any more`);
  const unknown = Object.entries(parity).flatMap(([action, covered]) =>
    typeof covered === "string" && !operationIds.has(covered)
      ? [`${action} names ${covered}, which is no operation`]
      : [],
  );
  return [...missing, ...stale, ...unknown];
}
