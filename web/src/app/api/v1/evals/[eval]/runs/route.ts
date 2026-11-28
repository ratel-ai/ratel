import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleStartEvalRunByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** POST /api/v1/evals/[eval]/runs: starts a run of one eval, with changes for this run only. */
export const POST = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ eval: string }> }) =>
    handleStartEvalRunByKey(
      req,
      decodeURIComponent((await params).eval),
      keyRunsDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/[eval]/runs"]),
    ),
);
