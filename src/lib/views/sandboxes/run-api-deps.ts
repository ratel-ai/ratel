import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
import { getSessionContext } from "@/lib/platform/session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { createPgSandboxRunStore, type SandboxDb } from "./adapters/pg-store";
import { readRecordedItems, readTraceMetrics } from "./adapters/recorded-items";
import { sharedRunNotifications } from "./adapters/run-notifications";
import { createPgFakeStore } from "./fakes/adapters/pg-fake-store";
import type { SandboxRunApiDeps } from "./run-api";

/** The production wiring of the sandbox run API routes. */
export const sandboxRunApiDeps: SandboxRunApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  sandboxesEnabled: (projectId) => sandboxesEnabledForProject(projectId),
  store: () => createPgSandboxRunStore(getDb() as unknown as SandboxDb),
  fakeStore: () => createPgFakeStore(getDb() as unknown as SandboxDb),
  recordedItems: (query) =>
    withStatementTimeout((db) => readRecordedItems(db as unknown as SandboxDb, query), {
      operation: "sandboxes_recorded_items",
    }),
  traceMetrics: (query) =>
    withStatementTimeout((db) => readTraceMetrics(db as unknown as SandboxDb, query), {
      operation: "sandboxes_run_metrics",
    }),
  notifications: sharedRunNotifications,
  track: (event, context, properties) =>
    trackServerEvent(event, context, { object_action: event, ...properties }),
};
