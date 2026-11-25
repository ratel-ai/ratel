import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleCompareByKey } from "@/lib/views/evals/baseline-api";
import { keyBaselineDeps } from "@/lib/views/evals/key-deps";

export const runtime = "nodejs";

/** GET /api/v1/evals/experiments/[experimentId]/comparison: against the pinned baseline. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ experimentId: string }> }) =>
    handleCompareByKey(
      (await params).experimentId,
      keyBaselineDeps(
        req,
        BEARER_ROUTE_SCOPES["GET /api/v1/evals/experiments/[experimentId]/comparison"],
      ),
    ),
);
