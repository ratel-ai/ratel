import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { completeSetup } from "@/lib/views/code-handoff/link-service";
import { SETUP_STATE_COOKIE, setupRedirectPath } from "@/lib/views/code-handoff/paths";
import { linkServiceDepsFor } from "@/lib/views/code-handoff/wiring";

/**
 * GET /api/github/setup - the Ratel GitHub App's callback URL (RC-914,
 * RC-958). With "Request user authorization (OAuth) during installation" on,
 * GitHub sends the person here after install with `code` (and usually
 * `installation_id`) and `state`; the authorize-only path sends `code` and
 * `state`. The URL's `state` must equal the install cookie: a missing one is
 * refused, so no one else's `code` can ride the cookie. `completeSetup` trades the
 * code for a user token, keeps only the installations GitHub lists for that
 * person, and writes nothing. Only the path is request-logged, never `code`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRequestLog(async (request: Request) => {
  const url = new URL(request.url);
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session) return NextResponse.redirect(new URL("/", url));

  const result = await completeSetup(
    {
      state: url.searchParams.get("state"),
      cookieState: (await cookies()).get(SETUP_STATE_COOKIE)?.value ?? null,
      code: url.searchParams.get("code"),
      installationId: url.searchParams.get("installation_id"),
      externalId: session.user.externalId,
    },
    linkServiceDepsFor(session),
  );
  const response = NextResponse.redirect(new URL(setupRedirectPath(result), url));
  response.cookies.delete({ name: SETUP_STATE_COOKIE, path: "/api/github" });
  return response;
});
