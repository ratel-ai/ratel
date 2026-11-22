import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { trackServerEvent } from "@/lib/platform/telemetry";
import {
  createDrizzleConsentStore,
  createDrizzleDatasetStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-store";
import { type ConsentApiDeps, handleConsentRequest } from "@/lib/views/fine-tuning/consent-api";
import { fineTuningEnabled } from "@/lib/views/fine-tuning/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The training opt-in of a project (RC-1123). Read by members, changed by admins; the logic is in `lib/fine-tuning/consent-api.ts`. */
const deps: ConsentApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isRestricted: isRestrictedBySupportSession,
  consents: () => createDrizzleConsentStore(getDb()),
  datasets: () => createDrizzleDatasetStore(),
  track: ({ name, externalId, projectId, organizationId, ...properties }) =>
    trackServerEvent(
      name,
      { externalId, projectId, orgId: organizationId },
      {
        object_action: name,
        text_version: properties.textVersion,
        ...("datasetsDeleted" in properties
          ? { datasets_deleted: properties.datasetsDeleted }
          : {}),
        surface: "console",
      },
    ),
};

async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId } = await context.params;
  return handleConsentRequest(request, projectId, deps);
}

export const GET = withRequestLog(handle);
export const POST = withRequestLog(handle);
export const DELETE = withRequestLog(handle);
