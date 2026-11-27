import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleCreateDatasetByKey, handleDatasetsByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/datasets: each dataset with its kind, its rows or its query, and its evals. */
export const GET = withRequestLog(async (req: Request) =>
  handleDatasetsByKey(keyRunsDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/datasets"])),
);

/** POST /api/v1/evals/datasets: creates a dataset. */
export const POST = withRequestLog(async (req: Request) =>
  handleCreateDatasetByKey(
    req,
    keyRunsDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/datasets"]),
  ),
);
