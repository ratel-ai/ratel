import { sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { DAILY_ORG_BUDGET_USD } from "@/lib/views/eval-gate/models";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import { MAX_SCORERS } from "./config";
import { definitionSummary, hasVerdict } from "./format";
import { countScorers, listScorers, type ScorerDb } from "./store";
import { rowsOf } from "./traces";
import type { ScorerKind } from "./types";
// The one daily budget counts every reader of it, the judge scorers' too.
import "./spend";

/** Where a scorer is used: dashboard widgets, alert rules and the tasks it is attached to. */
export interface ScorerUsage {
  widgets: number;
  alerts: number;
  tasks: number;
  total: number;
}

/** A scorer as a picker offers it. */
export interface PickerScorer {
  id: string;
  name: string;
  kind: ScorerKind;
  /** What it checks, in one line. */
  summary: string;
  /** Pass or fail; false: 1 to 5. */
  verdict: boolean;
  enabled: boolean;
  tasks: readonly string[] | null;
  usage: ScorerUsage;
}

/** What the picker of every surface reads: the scorers, and the room left to create one. */
export interface ScorerPickerData {
  scorers: PickerScorer[];
  count: number;
  limit: number;
  /** The organization's one daily model budget, over the last 24 hours. */
  budget: { dailyUsd: number; spentUsd: number; leftUsd: number };
  /** True when the read failed (`UNREAD_SCORERS`): the picker says so and offers no create. */
  unread: boolean;
}

/** A surface's picker when its read failed: no scorer, and no room claimed. */
export const UNREAD_SCORERS: ScorerPickerData = {
  scorers: [],
  count: 0,
  limit: MAX_SCORERS,
  budget: { dailyUsd: 0, spentUsd: 0, leftUsd: 0 },
  unread: true,
};

const DAY_MS = 86_400_000;
const NO_USE: Omit<ScorerUsage, "total"> = { widgets: 0, alerts: 0, tasks: 0 };

/** The project's scorers, oldest first, each with where it is used, and the limit and budget. */
export async function loadScorerPicker(
  projectId: string,
  now: Date = new Date(),
  db: ScorerDb & EvalDb = getDb(),
  dailyUsd: number = DAILY_ORG_BUDGET_USD,
): Promise<ScorerPickerData> {
  const [scorers, count, usage, spentUsd] = await Promise.all([
    listScorers(projectId, db),
    // The count the server's limit reads: the scorers the system made for tasks do not count.
    countScorers(projectId, db),
    scorerUsage(projectId, db),
    organizationModelSpendSince(projectId, new Date(now.getTime() - DAY_MS), db),
  ]);
  return {
    scorers: scorers.map((scorer) => {
      const used = usage.get(scorer.id) ?? NO_USE;
      return {
        id: scorer.id,
        name: scorer.name,
        kind: scorer.kind,
        summary: definitionSummary(scorer),
        verdict: hasVerdict(scorer),
        enabled: scorer.enabled,
        tasks: scorer.tasks,
        usage: { ...used, total: used.widgets + used.alerts + used.tasks },
      };
    }),
    count,
    limit: MAX_SCORERS,
    budget: { dailyUsd, spentUsd, leftUsd: Math.max(0, dailyUsd - spentUsd) },
    unread: false,
  };
}

/** The scorers by name only, for what names one (dashboard writes and exports): no usage or spend read. */
export async function scorerNames(
  projectId: string,
  db: ScorerDb = getDb(),
): Promise<Pick<PickerScorer, "id" | "name" | "verdict">[]> {
  return (await listScorers(projectId, db)).map((scorer) => ({
    id: scorer.id,
    name: scorer.name,
    verdict: hasVerdict(scorer),
  }));
}

/** Per scorer id, how many widgets, alert rules and tasks use it. A scorer used nowhere has no entry. */
export async function scorerUsage(
  projectId: string,
  db: Pick<ScorerDb, "execute">,
): Promise<Map<string, Omit<ScorerUsage, "total">>> {
  const [widgets, rules, tasks] = await Promise.all([
    db.execute(sql`select w.value as query from dashboards d,
      jsonb_array_elements(d.widgets) w where d.project_id = ${projectId}`),
    db.execute(sql`select query from alert_rules where project_id = ${projectId}`),
    db.execute(sql`select scorer_id, count(*)::int as n from trace_scorer_tasks
      where project_id = ${projectId} group by scorer_id`),
  ]);
  const usage = new Map<string, Omit<ScorerUsage, "total">>();
  const add = (id: string, key: keyof typeof NO_USE, n = 1) => {
    const current = usage.get(id) ?? { ...NO_USE };
    current[key] += n;
    usage.set(id, current);
  };
  for (const { query } of rowsOf<{ query: unknown }>(widgets))
    for (const id of scorerIdsOf(query)) add(id, "widgets");
  for (const { query } of rowsOf<{ query: unknown }>(rules))
    for (const id of scorerIdsOf(query)) add(id, "alerts");
  for (const { scorer_id, n } of rowsOf<{ scorer_id: string; n: number }>(tasks))
    add(scorer_id, "tasks", Number(n));
  return usage;
}

/** The scorer ids a stored widget or query names: the `id` of each `scorer` it holds, at any depth. */
export function scorerIdsOf(value: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown, key: string | null) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, null);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (key === "scorer" && typeof record.id === "string") ids.add(record.id);
    for (const [child, item] of Object.entries(record)) walk(item, child);
  };
  walk(value, null);
  return ids;
}
