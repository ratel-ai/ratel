import { after } from "next/server";
import { getConfig } from "@/config";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import { runDeps } from "./run-deps";
import type { SandboxRunsApiDeps } from "./sandbox-runs-api";

/** The runs API over the real database, provider and limits. A run goes on after the response. */
export function sandboxRunsApiDeps(req: Request, scope: ApiKeyScope): SandboxRunsApiDeps {
  return {
    authenticate: () => resolveProjectFromBearer(req, scope),
    organizationIdOf: async (projectId) =>
      (await getOrganizationByProjectId(projectId))?.id ?? null,
    versions: () => createDrizzleVersionStore(getDb()),
    runDeps: () => runDeps((work) => after(work)),
    publicOrigin: () => getConfig().app.publicUrl || null,
  };
}
