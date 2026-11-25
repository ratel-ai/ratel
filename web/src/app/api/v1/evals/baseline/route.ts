import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import {
  handleGetBaselineByKey,
  handlePinByKey,
  handleUnpinByKey,
} from "@/lib/views/evals/baseline-api";
import { keyBaselineDeps } from "@/lib/views/evals/key-deps";

export const runtime = "nodejs";

/** GET /api/v1/evals/baseline: the pinned baseline of the project of the key, or null. */
export const GET = withRequestLog(async (req: Request) =>
  handleGetBaselineByKey(keyBaselineDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/baseline"])),
);

/** PUT /api/v1/evals/baseline: pins a completed experiment. */
export const PUT = withRequestLog(async (req: Request) =>
  handlePinByKey(req, keyBaselineDeps(req, BEARER_ROUTE_SCOPES["PUT /api/v1/evals/baseline"])),
);

/** DELETE /api/v1/evals/baseline: removes the pin. */
export const DELETE = withRequestLog(async (req: Request) =>
  handleUnpinByKey(req, keyBaselineDeps(req, BEARER_ROUTE_SCOPES["DELETE /api/v1/evals/baseline"])),
);
