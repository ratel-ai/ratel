"use server";

import { cookies } from "next/headers";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { rememberLastProject } from "@/lib/console/scope/remember-project";
import { BASE_URL } from "@/lib/platform/app-config";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Remembers the open project in the last-project cookie, so `/` and `/project/_` return to it.
 * The project layout asks for it only when the cookie names another project. The cookie is
 * `Secure` when this deployment's origin is https: a self-hosted console on plain http would
 * otherwise never keep it.
 */
export async function rememberProjectAction(projectId: string): Promise<void> {
  if (!isDbConfigured()) return;
  const cookieStore = await cookies();
  await rememberLastProject(projectId, {
    current: async () => cookieStore.get(LAST_PROJECT_COOKIE)?.value,
    resolveProjectScope: (id) => findProjectScope(id),
    write: (cookie) => {
      cookieStore.set(cookie.name, cookie.value, cookie.options);
    },
    secure: BASE_URL.startsWith("https://"),
  });
}
