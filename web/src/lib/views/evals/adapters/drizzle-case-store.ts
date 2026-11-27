import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { storable } from "@/lib/platform/storable";
import type { CaseContent, CaseVersion, EvalCase, VersionState } from "../domain/case";
import type { CaseStore } from "../ports/case-store";
import { evalCases, evalCaseVersions, evalDefinitions } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "transaction">;
type CaseRow = typeof evalCases.$inferSelect;
type VersionRow = typeof evalCaseVersions.$inferSelect;

export function createDrizzleCaseStore(db: Db): CaseStore {
  return {
    create({ projectId, evalId, name, labels, content, createdBy, source }) {
      return db.transaction(async (tx) => {
        const now = new Date();
        // The lock keeps the eval while the case joins it.
        const [owner] = await tx
          .select({ id: evalDefinitions.id })
          .from(evalDefinitions)
          .where(and(eq(evalDefinitions.projectId, projectId), eq(evalDefinitions.id, evalId)))
          .for("share");
        if (!owner) return "eval_not_found";
        const [row] = await tx
          .insert(evalCases)
          .values({ ...storable({ name, labels }), projectId, evalId, createdBy })
          .returning();
        if (!row) throw new Error("the case row is missing");
        const [version] = await tx
          .insert(evalCaseVersions)
          .values({
            ...columns(content),
            caseId: row.id,
            number: 1,
            sourceTurnId: source?.turnId ?? null,
            sourceOutput: storable(source?.output ?? null),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!version) throw new Error("the version row is missing");
        return toCase(row, [version]);
      });
    },

    async get(projectId, caseId) {
      const [row] = await db
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.projectId, projectId), eq(evalCases.id, caseId)));
      if (!row) return null;
      const versions = await db
        .select()
        .from(evalCaseVersions)
        .where(eq(evalCaseVersions.caseId, caseId))
        .orderBy(desc(evalCaseVersions.number));
      return toCase(row, versions);
    },

    async list(projectId, evalId) {
      const rows = await db
        .select()
        .from(evalCases)
        .where(
          and(
            eq(evalCases.projectId, projectId),
            evalId === undefined ? undefined : eq(evalCases.evalId, evalId),
          ),
        )
        .orderBy(desc(evalCases.createdAt), desc(evalCases.id));
      if (rows.length === 0) return [];
      const versions = await db
        .select()
        .from(evalCaseVersions)
        .where(
          inArray(
            evalCaseVersions.caseId,
            rows.map(({ id }) => id),
          ),
        )
        .orderBy(desc(evalCaseVersions.number));
      const byCase = Map.groupBy(versions, ({ caseId }) => caseId);
      return rows.map((row) => toCase(row, byCase.get(row.id) ?? []));
    },

    saveDraft(projectId, caseId, { name, labels, content }, base, now) {
      return db.transaction(async (tx) => {
        // The row lock: two edits at the same time make one draft.
        const [found] = await tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(and(eq(evalCases.projectId, projectId), eq(evalCases.id, caseId)))
          .for("update");
        if (!found) return "not_found";
        const [newest] = await tx
          .select()
          .from(evalCaseVersions)
          .where(eq(evalCaseVersions.caseId, caseId))
          .orderBy(desc(evalCaseVersions.number))
          .limit(1);
        if (!newest) throw new Error("the case has no version");
        if (newest.id !== base.versionId || +newest.updatedAt !== +base.updatedAt) return "changed";
        const [row] = await tx
          .update(evalCases)
          .set(storable({ name, labels }))
          .where(eq(evalCases.id, caseId))
          .returning();
        if (!row) throw new Error("the case row is missing");
        // Each write has its own time, so the time names one state of the draft.
        const updatedAt = new Date(Math.max(now.getTime(), newest.updatedAt.getTime() + 1));
        if (newest.state === "draft") {
          await tx
            .update(evalCaseVersions)
            .set({ ...columns(content), updatedAt })
            .where(isDraft(newest.id));
        } else if (!isDeepStrictEqual(columns(content), columns(toVersion(newest)))) {
          await tx.insert(evalCaseVersions).values({
            ...columns(content),
            caseId,
            number: newest.number + 1,
            sourceTurnId: newest.sourceTurnId,
            sourceOutput: newest.sourceOutput,
            createdAt: now,
            updatedAt,
          });
        }
        const versions = await tx
          .select()
          .from(evalCaseVersions)
          .where(eq(evalCaseVersions.caseId, caseId))
          .orderBy(desc(evalCaseVersions.number));
        return toCase(row, versions);
      });
    },

    approve(projectId, caseId, { versionId, updatedAt }, { userId, now }) {
      return db.transaction(async (tx) => {
        // The same row lock as an edit takes.
        const [row] = await tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(and(eq(evalCases.projectId, projectId), eq(evalCases.id, caseId)))
          .for("update");
        if (!row) return "not_found";
        const approved = await tx
          .update(evalCaseVersions)
          .set({ state: "approved", approvedBy: userId, approvedAt: now })
          .where(
            and(
              isDraft(versionId),
              eq(evalCaseVersions.caseId, caseId),
              eq(evalCaseVersions.updatedAt, updatedAt),
            ),
          )
          .returning({ id: evalCaseVersions.id });
        return approved.length > 0 ? "approved" : "changed";
      });
    },
  };
}

/** Each write of a version has this condition: an approved version never changes. */
function isDraft(versionId: string) {
  return and(eq(evalCaseVersions.id, versionId), eq(evalCaseVersions.state, "draft"));
}

function columns({ input, earlierTurns, toolFixtures, expectedOutput }: CaseContent) {
  return storable({
    input: { value: input ?? null },
    earlierTurns,
    toolFixtures,
    expectedOutput,
  });
}

function toCase(row: CaseRow, versions: VersionRow[]): EvalCase {
  const { id, projectId, evalId, name, labels, createdAt } = row;
  return { id, projectId, evalId, name, labels, createdAt, versions: versions.map(toVersion) };
}

export function toVersion(row: VersionRow): CaseVersion {
  const { createdAt: _, state, input, ...rest } = row;
  return { ...rest, state: state as VersionState, input: input.value ?? null };
}
