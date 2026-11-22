import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { evals } from "@/lib/views/evals/schema";
import { evalScorerOverrides, type ScorerRow, scorers } from "@/lib/views/scorers/schema";
import { parseDefinition, parseName, parseThreshold, ScorerConfigError } from "../domain/config";
import {
  DEFAULT_GOOD_THRESHOLD,
  SCORER_SCOPES,
  type Scorer,
  type ScorerOverride,
  type ScorerScope,
} from "../domain/types";
import type { NewScorer, ScorerPatch, ScorerRepository } from "../ports";

type Db = ReturnType<typeof getDb>;

const MAX_TASK_ID_CHARS = 200;

/**
 * The `scorers` and `eval_scorer_overrides` tables as a scorer repository.
 * Every write validates through the domain, so a stored config always parses.
 * Callers enforce the `cloud-eval-gate` flag.
 */
export function drizzleScorerRepository(db: Db = getDb()): ScorerRepository {
  return {
    async list(projectId, filter = {}) {
      const where = [eq(scorers.projectId, projectId)];
      if (filter.taskId !== undefined) where.push(eq(scorers.taskId, filter.taskId));
      if (filter.scope !== undefined) where.push(eq(scorers.scope, filter.scope));
      const rows = await db
        .select()
        .from(scorers)
        .where(and(...where))
        .orderBy(asc(scorers.createdAt), asc(scorers.id));
      return rows.map(scorerOf);
    },

    async get(projectId, id) {
      if (!isUuid(id)) return null;
      const [row] = await db
        .select()
        .from(scorers)
        .where(and(eq(scorers.projectId, projectId), eq(scorers.id, id)));
      return row ? scorerOf(row) : null;
    },

    async create(input: NewScorer) {
      const definition = parseDefinition(input.kind, input.config);
      const { scope, taskId } = placement(input.scope, input.taskId);
      const [row] = await db
        .insert(scorers)
        .values({
          projectId: input.projectId,
          taskId,
          scope,
          name: parseName(input.name),
          kind: definition.kind,
          config: definition.config as unknown as Record<string, unknown>,
          enabled: input.enabled ?? true,
          goodThreshold:
            input.goodThreshold === undefined
              ? DEFAULT_GOOD_THRESHOLD
              : parseThreshold(input.goodThreshold),
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();
      return scorerOf(row!);
    },

    async update(projectId, id, patch: ScorerPatch) {
      const current = await this.get(projectId, id);
      if (!current) return null;
      const set: Partial<typeof scorers.$inferInsert> = {
        updatedBy: patch.updatedBy,
        updatedAt: new Date(),
      };
      if (patch.name !== undefined) set.name = parseName(patch.name);
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (patch.goodThreshold !== undefined)
        set.goodThreshold = parseThreshold(patch.goodThreshold);
      const changesDefinition = patch.kind !== undefined || patch.config !== undefined;
      if (changesDefinition) {
        const definition = parseDefinition(
          patch.kind ?? current.kind,
          patch.config ?? current.config,
        );
        set.kind = definition.kind;
        set.config = definition.config as unknown as Record<string, unknown>;
      }
      // A new reading of runs is a new version; a name or a switch is not.
      const [row] = await db
        .update(scorers)
        .set({
          ...set,
          ...(changesDefinition || patch.goodThreshold !== undefined
            ? { version: sql`${scorers.version} + 1` }
            : {}),
        })
        .where(and(eq(scorers.projectId, projectId), eq(scorers.id, id)))
        .returning();
      return row ? scorerOf(row) : null;
    },

    async remove(projectId, id) {
      if (!isUuid(id)) return false;
      const removed = await db
        .delete(scorers)
        .where(and(eq(scorers.projectId, projectId), eq(scorers.id, id)))
        .returning({ id: scorers.id });
      return removed.length > 0;
    },

    async setOverride(projectId, evalId, scorerId, enabled, updatedBy) {
      if (!isUuid(evalId) || !isUuid(scorerId))
        throw new ScorerConfigError("The eval or the scorer does not exist in this project.");
      const [owned] = await db
        .select({ evalId: evals.id })
        .from(evals)
        .innerJoin(scorers, and(eq(scorers.projectId, evals.projectId), eq(scorers.id, scorerId)))
        .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)));
      if (!owned)
        throw new ScorerConfigError("The eval or the scorer does not exist in this project.");
      if (enabled === null) {
        await db
          .delete(evalScorerOverrides)
          .where(
            and(eq(evalScorerOverrides.evalId, evalId), eq(evalScorerOverrides.scorerId, scorerId)),
          );
        return;
      }
      await db
        .insert(evalScorerOverrides)
        .values({ evalId, scorerId, enabled, updatedBy })
        .onConflictDoUpdate({
          target: [evalScorerOverrides.evalId, evalScorerOverrides.scorerId],
          set: { enabled, updatedBy, updatedAt: new Date() },
        });
    },

    async overrides(projectId, evalIds) {
      const result = new Map<string, ScorerOverride[]>();
      const ids = evalIds.filter(isUuid);
      if (ids.length === 0) return result;
      const rows = await db
        .select({
          evalId: evalScorerOverrides.evalId,
          scorerId: evalScorerOverrides.scorerId,
          enabled: evalScorerOverrides.enabled,
        })
        .from(evalScorerOverrides)
        .innerJoin(evals, eq(evals.id, evalScorerOverrides.evalId))
        .where(and(eq(evals.projectId, projectId), inArray(evalScorerOverrides.evalId, ids)));
      for (const row of rows) {
        const list = result.get(row.evalId) ?? [];
        list.push({ scorerId: row.scorerId, enabled: row.enabled });
        result.set(row.evalId, list);
      }
      return result;
    },
  };
}

function scorerOf(row: ScorerRow): Scorer {
  return {
    ...parseDefinition(row.kind, row.config),
    id: row.id,
    name: row.name,
    scope: row.scope,
    taskId: row.taskId,
    enabled: row.enabled,
    goodThreshold: row.goodThreshold,
    version: row.version,
  };
}

function placement(scope: unknown, taskId: unknown): { scope: ScorerScope; taskId: string | null } {
  if (typeof scope !== "string" || !(SCORER_SCOPES as readonly string[]).includes(scope)) {
    throw new ScorerConfigError(
      `Unknown scorer scope "${String(scope)}". Use one of: ${SCORER_SCOPES.join(", ")}.`,
    );
  }
  if (scope === "suite") {
    if (taskId !== null && taskId !== undefined)
      throw new ScorerConfigError("A suite scorer applies to every eval. Leave the task out.");
    return { scope: "suite", taskId: null };
  }
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > MAX_TASK_ID_CHARS)
    throw new ScorerConfigError("A task scorer needs its task id.");
  return { scope: "task", taskId: taskId.trim() };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
