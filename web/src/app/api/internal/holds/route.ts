import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { isDbConfigured } from "@/lib/platform/db/client";
import { handleHoldsGet, handleHoldsPost, storedHolds } from "@/lib/platform/org-hold/holds-route";
import { withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

const deps = {
  ...storedHolds,
  isDbConfigured,
  startJobs: (projectId: string) => scheduleProjectDrain(projectId),
};

/** Put an organization or projects on hold, lift it, or read its status (docs/internal-api.md). */
export const GET = withRequestLog((request: Request) => handleHoldsGet(request, deps));
export const POST = withRequestLog((request: Request) => handleHoldsPost(request, deps));
