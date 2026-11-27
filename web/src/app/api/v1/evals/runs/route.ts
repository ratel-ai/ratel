import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleStartRunsByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** POST /api/v1/evals/runs: starts one run for each eval (or each eval named), with per-run changes. */
export const POST = withRequestLog(async (req: Request) =>
  handleStartRunsByKey(req, keyModelDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/runs"])),
);
