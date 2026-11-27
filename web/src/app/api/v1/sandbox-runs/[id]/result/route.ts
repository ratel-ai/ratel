import { after } from "next/server";
import { withRequestLog } from "@/lib/platform/request-log";
import { sandboxesEnabledForProject, sandboxesOffForAll } from "@/lib/views/sandboxes/gate";
import { handleRunResult } from "@/lib/views/sandboxes/result-api";
import { runDeps } from "@/lib/views/sandboxes/run-deps";

export const runtime = "nodejs";

/** POST /api/v1/sandbox-runs/[id]/result: the result of a run, with its run token. */
export const POST = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
    handleRunResult(req, (await params).id, {
      ...runDeps(),
      offForAll: () => sandboxesOffForAll(),
      enabled: (projectId) => sandboxesEnabledForProject(projectId),
      afterResponse: after,
    }),
);
