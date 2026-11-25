import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleGetByKey } from "@/lib/views/evals/experiments-api";
import { keyExperimentDeps } from "@/lib/views/evals/key-deps";

export const runtime = "nodejs";

/** GET /api/v1/evals/experiments/[experimentId]: its state and the raw counts of each case. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ experimentId: string }> }) =>
    handleGetByKey(
      (await params).experimentId,
      keyExperimentDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/experiments/[experimentId]"]),
    ),
);
