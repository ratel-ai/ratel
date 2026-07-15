import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { SkillCatalog, TraceSession } from "@ratel-ai/sdk";
import { CloudClient, type CloudExporter, type SkillSync } from "@ratel-ai/cloud";

type Sdk = typeof import("@ratel-ai/sdk");

/**
 * Load `@ratel-ai/sdk` with a bundler-invisible require. This example consumes
 * the UNPUBLISHED workspace SDK, and Next bundles monorepo-local (symlinked)
 * packages even when they're in `serverExternalPackages` — which breaks the
 * SDK's native `.node` addon. A real app on the published npm SDK doesn't need
 * this: `serverExternalPackages: ["@ratel-ai/sdk", ...]` is enough (see
 * ratel-websites/apps/cloud/next.config.ts).
 */
function loadSdk(): Sdk {
  const req = createRequire(join(process.cwd(), "package.json"));
  return req("@ratel-ai" + "/sdk") as Sdk;
}

/**
 * Server-side Ratel wiring for the demo app. One `CloudClient` for the
 * project; one `TraceSession` + `SkillCatalog` + `CloudExporter` per opaque
 * end-user (the exporter stamps `end_user_id` on every envelope, and the
 * catalog is attached to that user's session so every `searchTraced`/`invoke`
 * the agent performs is attributed to them).
 *
 * Everything hangs off `globalThis` so Next.js dev-mode module reloads reuse
 * the same live sessions instead of leaking exporters.
 */

export interface UserRuntime {
  endUserId: string;
  session: TraceSession;
  catalog: SkillCatalog;
  exporter: CloudExporter;
  sync: SkillSync;
}

interface RatelStore {
  sdk?: Sdk;
  client?: CloudClient;
  users?: Map<string, Promise<UserRuntime>>;
}

const g = globalThis as typeof globalThis & { __ratelDemoStore?: RatelStore };
const store: RatelStore = (g.__ratelDemoStore ??= {});

/** Cloud origin the app talks to (also linked from the UI header). */
export function cloudUrl(): string {
  return process.env.RATEL_CLOUD_URL ?? "http://localhost:3000";
}

export function getCloud(): CloudClient {
  // CloudClient reads RATEL_CLOUD_URL / RATEL_CLOUD_API_KEY from the env.
  return (store.client ??= new CloudClient());
}

export function getUserRuntime(endUserId: string): Promise<UserRuntime> {
  const users = (store.users ??= new Map());
  let runtime = users.get(endUserId);
  if (!runtime) {
    runtime = createRuntime(endUserId);
    users.set(endUserId, runtime);
    // A failed boot (cloud down, bad key) must not poison the cache.
    runtime.catch(() => users.delete(endUserId));
  }
  return runtime;
}

async function createRuntime(endUserId: string): Promise<UserRuntime> {
  const sdk = (store.sdk ??= loadSdk());
  const cloud = getCloud();
  const session = new sdk.TraceSession({
    sessionId: randomUUID(),
    harness: "end-user-skills-app",
  });
  const catalog = new sdk.SkillCatalog({ traceSession: session });
  const sync = await cloud.syncSkills(catalog, { traceSession: session });
  const exporter = cloud.createExporter(session, {
    endUserId,
    flushIntervalMs: 5_000,
    onError: (err) => console.error(`[exporter:${endUserId}]`, err.message),
    onRejected: (rejected) => console.error(`[exporter:${endUserId}] rejected:`, rejected),
  });
  exporter.start();
  return { endUserId, session, catalog, exporter, sync };
}
