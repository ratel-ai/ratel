import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { withRequestLog } from "@/lib/platform/request-log";
import { finishInstall } from "@/lib/views/slack/install";
import { guarded, installDeps, respond } from "../deps";

export const runtime = "nodejs";

/** Where Slack sends the person back, with a one-time code. Never logged, never repeated. */
export const GET = withRequestLog((request: Request) =>
  guarded(async () => {
    const query = new URL(request.url).searchParams;
    const result = await finishInstall(
      { state: query.get("state"), code: query.get("code"), error: query.get("error") },
      installDeps(),
    );
    if (!result.ok) return respond(result.status, result.error);
    const answer = new URLSearchParams({ slack: result.notice });
    if (result.code) answer.set("reason", result.code);
    // Relative: behind a proxy the request's own address is the container's.
    return respond(303, null, `${projectSettingsRoot(result.projectId)}/notifications?${answer}`);
  }),
);
