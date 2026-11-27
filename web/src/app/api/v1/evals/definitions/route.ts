import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleCreateEvalByKey, handleListEvalsByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/definitions: each eval with its rows, scorers, baseline and newest score, and its series. */
export const GET = withRequestLog(async (req: Request) =>
  handleListEvalsByKey(keyModelDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/definitions"])),
);

/** POST /api/v1/evals/definitions: creates an eval (a dataset, a runtime, scorers, trials, a matrix). */
export const POST = withRequestLog(async (req: Request) =>
  handleCreateEvalByKey(
    req,
    keyModelDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/definitions"]),
  ),
);
