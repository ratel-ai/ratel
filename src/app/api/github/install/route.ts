import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import {
  appAuthorizeUrl,
  appInstallUrl,
  readGitHubAppConfig,
} from "@/lib/views/code-handoff/config";
import { startInstall } from "@/lib/views/code-handoff/link-service";
import { repositorySettingsPath, SETUP_STATE_COOKIE } from "@/lib/views/code-handoff/paths";
import { SETUP_STATE_TTL_MS } from "@/lib/views/code-handoff/setup-state";
import { linkServiceDepsFor } from "@/lib/views/code-handoff/wiring";

/**
 * GET /api/github/install?project=<id>[&mode=authorize] - the Install link of
 * Project settings › Repository (RC-958). Checks access, puts the
 * signed setup state in an httpOnly cookie (the setup route requires GitHub's
 * `state` to equal it), then sends the person to GitHub: the App's install page, or
 * for an App already installed, its user authorization alone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRequestLog(async (request: Request) => {
  const url = new URL(request.url);
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session) return NextResponse.redirect(new URL("/", url));

  const projectId = url.searchParams.get("project") ?? "";
  const started = await startInstall(
    { projectId, externalId: session.user.externalId },
    linkServiceDepsFor(session),
  );
  const config = readGitHubAppConfig();
  if (!started.ok || !config) {
    const error = started.ok ? "not_configured" : started.error;
    const target = error === "forbidden" ? "/" : repositorySettingsPath(projectId);
    return NextResponse.redirect(new URL(`${target}?github_setup_error=${error}`, url));
  }

  const destination =
    url.searchParams.get("mode") === "authorize"
      ? appAuthorizeUrl(config, started.state)
      : appInstallUrl(config, started.state);
  const response = NextResponse.redirect(destination);
  response.cookies.set(SETUP_STATE_COOKIE, started.state, {
    httpOnly: true,
    secure: url.protocol === "https:",
    // Lax: the cookie still rides GitHub's top-level redirect back to us.
    sameSite: "lax",
    path: "/api/github",
    maxAge: SETUP_STATE_TTL_MS / 1000,
  });
  return response;
});
