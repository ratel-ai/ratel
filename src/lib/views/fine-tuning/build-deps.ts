import { eq, getTableColumns } from "drizzle-orm";
import { enqueueJob } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { organizations } from "@/lib/platform/db/test-support";
import type { Organization } from "@/lib/platform/organizations";
import { projects } from "@/lib/platform/projects/schema";
import { type ServerEventContext, trackServerEvent } from "@/lib/platform/telemetry";
import { datasetRef } from "@/lib/views/lineage/refs";
import { recordLineage } from "@/lib/views/lineage/resolve";
import type { LineageRef } from "@/lib/views/lineage/types";
import {
  createDrizzleBuildFactSource,
  createDrizzleDatasetStore,
  createDrizzleOverrideStore,
} from "./adapters/drizzle-dataset-store";
import {
  createDrizzleConsentStore,
  createDrizzleModelCallSource,
  createDrizzleUseCaseStore,
} from "./adapters/drizzle-store";
import {
  BUILD_DATASET_JOB,
  type DatasetBuildDeps,
  type DatasetEvent,
  FINE_TUNING_ACTOR,
  runDatasetBuild,
} from "./build";
import type { UseCase } from "./domain/use-case";
import { fineTuningEnabled } from "./flag";

/**
 * The real collaborators of a dataset build (RC-1128). The job handler runs
 * on them; a route swaps `enqueue` for one that also drains after the
 * response. This file must not import `lib/jobs/store.ts`: `handlers.ts`
 * imports it (RC-189).
 */

type Db = ReturnType<typeof getDb>;

/** The `build_fine_tuning_dataset` handler: `jobHandlers` imports it. */
export function buildFineTuningDatasetJob(job: { projectId: string; payload: unknown }) {
  return runDatasetBuild(job.projectId, job.payload, datasetBuildDeps());
}

export function datasetBuildDeps(db: Db = getDb()): DatasetBuildDeps {
  return {
    datasets: createDrizzleDatasetStore(db),
    useCases: createDrizzleUseCaseStore(db),
    consents: createDrizzleConsentStore(db),
    overrides: createDrizzleOverrideStore(db),
    calls: createDrizzleModelCallSource(db),
    facts: createDrizzleBuildFactSource(db),
    flagOn: (projectId) => fineTuningEnabledForProject(projectId, db),
    enqueue: async (projectId, payload) => {
      await enqueueJob({ projectId, kind: BUILD_DATASET_JOB, payload }, db);
    },
    recordSource: async (projectId, dataset, useCase) => {
      await recordDatasetSource(projectId, dataset.id, useCase, db);
    },
    track: trackDatasetEvent,
  };
}

/** `FF_FINE_TUNING` for the project's organization, as a system job sees it. Off for an unknown project. */
export async function fineTuningEnabledForProject(
  projectId: string,
  db: Pick<Db, "select"> = getDb(),
): Promise<boolean> {
  const [organization] = await db
    .select(getTableColumns(organizations))
    .from(organizations)
    .innerJoin(projects, eq(projects.organizationId, organizations.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  return organization ? fineTuningEnabled(organization as Organization) : false;
}

/** The dataset's one lineage link: the use case's first task, else its first intent. */
export async function recordDatasetSource(
  projectId: string,
  datasetId: string,
  useCase: UseCase,
  db: Db = getDb(),
): Promise<LineageRef | null> {
  const [taskId] = useCase.selector.taskIds;
  const [intentId] = useCase.selector.intentIds;
  const source: LineageRef | null = taskId
    ? { stage: "insights", kind: "task", id: taskId, label: taskId }
    : intentId
      ? { stage: "insights", kind: "intent", id: intentId }
      : null;
  if (!source) return null;
  return recordLineage(
    {
      projectId,
      object: datasetRef(projectId, datasetId, useCase.id, useCase.name),
      source,
      actor: { distinctId: FINE_TUNING_ACTOR, projectId },
    },
    db,
  );
}

export async function trackDatasetEvent(event: DatasetEvent): Promise<void> {
  const { dataset } = event;
  const context: ServerEventContext =
    event.name === "dataset_build_started"
      ? event.actor.startsWith("project:")
        ? { projectId: event.projectId }
        : { externalId: event.actor, projectId: event.projectId }
      : { distinctId: FINE_TUNING_ACTOR, projectId: event.projectId };
  await trackServerEvent(event.name, context, {
    object_action: event.name,
    project_id: event.projectId,
    dataset_id: dataset.id,
    use_case_id: dataset.useCaseId,
    version: dataset.version,
    dedup: dataset.settings.dedup,
    eval_fraction: dataset.settings.evalFraction,
    redaction_version: dataset.settings.redactionVersion,
    ...(event.name === "dataset_built" && dataset.counts
      ? {
          train_rows: dataset.counts.train,
          eval_rows: dataset.counts.eval,
          turns: dataset.counts.turns,
        }
      : {}),
    ...(event.name === "dataset_build_failed" ? { reason: event.reason } : {}),
  });
}
