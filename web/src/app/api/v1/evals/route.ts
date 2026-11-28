import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleCreateEvalByKey, handleEvalsOverviewByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** GET /api/v1/evals: each eval with its cases, scorers, baseline score, newest score and score series. */
export const GET = withRequestLog(async (req: Request) =>
  handleEvalsOverviewByKey(keyRunsDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals"])),
);

/** POST /api/v1/evals: creates an eval. */
export const POST = withRequestLog(async (req: Request) =>
  handleCreateEvalByKey(req, keyRunsDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals"])),
);
