import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleLibraryByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/scorers: the scorer library: the project's scorers, the pre-defined set, the evals' own. */
export const GET = withRequestLog(async (req: Request) =>
  handleLibraryByKey(keyModelDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/scorers"])),
);
