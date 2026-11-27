import { withRequestLog } from "@/lib/platform/request-log";
import { startInstall } from "@/lib/views/slack/install";
import { guarded, installDeps, respond } from "../deps";

export const runtime = "nodejs";

/** Add to Slack: `?projectId=`, the project whose Notifications page the person comes back to. */
export const GET = withRequestLog((request: Request) =>
  guarded(async () => {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const result = await startInstall(projectId, installDeps());
    return result.ok ? respond(303, null, result.location) : respond(result.status, result.error);
  }),
);
