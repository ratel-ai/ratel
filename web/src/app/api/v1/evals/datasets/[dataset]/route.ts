import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleDatasetByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/datasets/[dataset]: one dataset (id or name) with its rows, with no captured text. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ dataset: string }> }) =>
    handleDatasetByKey(
      decodeURIComponent((await params).dataset),
      keyRunsDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/datasets/[dataset]"]),
    ),
);
