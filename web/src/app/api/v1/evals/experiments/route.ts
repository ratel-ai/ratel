import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleListByKey, handleStartByKey } from "@/lib/views/evals/experiments-api";
import { keyExperimentDeps } from "@/lib/views/evals/key-deps";

export const runtime = "nodejs";

/** GET /api/v1/evals/experiments: the newest experiments of the project of the key. */
export const GET = withRequestLog(async (req: Request) =>
  handleListByKey(keyExperimentDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/experiments"])),
);

/** POST /api/v1/evals/experiments: starts one. */
export const POST = withRequestLog(async (req: Request) =>
  handleStartByKey(
    req,
    keyExperimentDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/experiments"]),
  ),
);
