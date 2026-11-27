import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleCreateDatasetByKey, handleListDatasetsByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/datasets: each dataset with its kind, rows or query, and the evals that use it. */
export const GET = withRequestLog(async (req: Request) =>
  handleListDatasetsByKey(keyModelDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/datasets"])),
);

/** POST /api/v1/evals/datasets: creates a dataset (fixed, or a query kind with its settings). */
export const POST = withRequestLog(async (req: Request) =>
  handleCreateDatasetByKey(
    req,
    keyModelDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/datasets"]),
  ),
);
