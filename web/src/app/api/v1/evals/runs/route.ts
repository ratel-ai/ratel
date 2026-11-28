import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleStartEachByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** POST /api/v1/evals/runs: one run for each eval (or for the evals named). */
export const POST = withRequestLog(async (req: Request) =>
  handleStartEachByKey(req, keyRunsDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/runs"])),
);
