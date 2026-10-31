/**
 * Test support for the tool network: a map model from compact rows, and a
 * project shaped like the seeded demo (a widely shared hub, small groups of
 * tools that answer the same asks, and tools that stand alone).
 */
import type {
  IntentMapModel,
  MapAsk,
  MapCapability,
  MapLink,
} from "@/lib/views/intents/map/map-model";

/** `[ask, tool, calls]`; a tool is `tool:<name>` unless it is written `skill:<name>`. Asks are as busy as their calls. */
export type FixtureRow = [string, string, number];

export function mapModelFrom(
  rows: readonly FixtureRow[],
  missing: readonly string[] = [],
): IntentMapModel {
  const asks = new Map<string, MapAsk>();
  const capabilities = new Map<string, MapCapability>();
  const links: MapLink[] = [];
  for (const [ask, tool, weight] of rows) {
    const id = tool.startsWith("skill:") ? tool : `tool:${tool}`;
    const seenAsk = asks.get(ask);
    asks.set(ask, {
      id: ask,
      label: `ask ${ask}`,
      volume: (seenAsk?.volume ?? 0) + weight,
      phrasings: 1,
      firstTry: null,
      rankedByGraph: 0,
      problem: null,
    });
    const seen = capabilities.get(id);
    capabilities.set(id, {
      id,
      kind: id.startsWith("skill:") ? "skill" : "tool",
      name: id.slice(id.indexOf(":") + 1),
      calls: (seen?.calls ?? 0) + weight,
      asks: (seen?.asks ?? 0) + 1,
      missing: missing.includes(id),
    });
    links.push({ ask, capability: id, weight, share: 0 });
  }
  return {
    asks: [...asks.values()].sort((a, b) => b.volume - a.volume || a.id.localeCompare(b.id)),
    capabilities: [...capabilities.values()].sort(
      (a, b) => b.calls - a.calls || a.id.localeCompare(b.id),
    ),
    links,
    hidden: null,
  };
}

/** The demo project's shape: 35 tools and skills over 29 ask groups. */
export const DEMO_ROWS: readonly FixtureRow[] = [
  ["intent_64", "github_api", 33],
  ["intent_77", "github_api", 14],
  ["intent_78", "github_api", 9],
  ["intent_63", "github_api", 5],
  ["intent_76", "github_api", 4],
  ["intent_63", "ripgrep", 57],
  ["intent_76", "ripgrep", 26],
  ["intent_65", "acme_update_task", 52],
  ["intent_70", "acme_update_task", 17],
  ["intent_68", "test_runner", 25],
  ["intent_60", "test_runner", 7],
  ["intent_61", "stripe_get_customer", 14],
  ["intent_80", "stripe_get_customer", 2],
  ["intent_83", "vercel_promote_deployment", 10],
  ["intent_75", "vercel_promote_deployment", 2],
  ["intent_83", "flaky_deploy_api", 8],
  ["intent_75", "flaky_deploy_api", 4],
  ["intent_67", "lookup_order", 86],
  ["intent_62", "acme_create_task", 62],
  ["intent_61", "stripe_search_customers", 22],
  ["intent_64", "skill:review-pull-request", 22],
  ["intent_73", "acme_add_task_comment", 20],
  ["intent_74", "skill:write-unit-tests", 18],
  ["intent_82", "acme_list_my_active_tasks", 17],
  ["intent_66", "stacktrace_parser", 17],
  ["intent_0", "search_docs", 15],
  ["intent_84", "slack_post_message", 14],
  ["intent_66", "sentry_get_issue", 13],
  ["intent_80", "stripe_refund_charge", 12],
  ["intent_69", "acme_link_pr_to_task", 12],
  ["intent_79", "acme_list_overdue_tasks", 11],
  ["intent_82", "acme_search_my_tasks_by_keyword", 11],
  ["intent_72", "stripe_cancel_subscription", 10],
  ["intent_70", "acme_complete_task_with_review", 9],
  ["intent_62", "linear_create_issue", 8],
  ["intent_71", "gmail_send_message", 7],
  ["intent_67", "stripe_list_invoices", 5],
  ["intent_69", "linear_link_pr_to_issue", 4],
  ["intent_77", "vercel_get_deployment_logs", 4],
  ["intent_81", "postgres_run_query", 2],
  ["intent_71", "gmail_create_draft", 2],
  ["intent_85", "calendar_list_events", 2],
  ["intent_86", "sentry_list_recent_issues", 2],
  ["intent_79", "acme_filter_tasks", 1],
  ["intent_87", "vercel_rollback_production", 1],
];
