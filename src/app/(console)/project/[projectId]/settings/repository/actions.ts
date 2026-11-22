"use server";

import { revalidatePath } from "next/cache";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { linkProjectRepo, unlinkProjectRepo } from "@/lib/views/code-handoff/link-service";
import { LINK_ERROR_MESSAGES, repositorySettingsPath } from "@/lib/views/code-handoff/paths";
import { linkServiceDepsFor } from "@/lib/views/code-handoff/wiring";

/**
 * Link and Unlink on Project settings › Repository (RC-914). Every input is
 * checked again by the link service: the person's access to the project, the
 * flag and the grant from GitHub's setup redirect.
 */

export type RepoActionResult = { ok: true } | { ok: false; error: string };

export async function linkRepoAction(
  projectId: string,
  grant: string,
  repoId: number,
): Promise<RepoActionResult> {
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session) return { ok: false, error: LINK_ERROR_MESSAGES.forbidden };
  const result = await linkProjectRepo(
    { projectId, externalId: session.user.externalId },
    { grant, repoId },
    linkServiceDepsFor(session),
  );
  if (!result.ok) return { ok: false, error: LINK_ERROR_MESSAGES[result.error] };
  revalidatePath(repositorySettingsPath(projectId));
  return { ok: true };
}

export async function unlinkRepoAction(projectId: string): Promise<RepoActionResult> {
  const session = isDbConfigured() ? await getSessionContext() : null;
  if (!session) return { ok: false, error: LINK_ERROR_MESSAGES.forbidden };
  const result = await unlinkProjectRepo(
    { projectId, externalId: session.user.externalId },
    linkServiceDepsFor(session),
  );
  if (!result.ok) return { ok: false, error: LINK_ERROR_MESSAGES[result.error] };
  revalidatePath(repositorySettingsPath(projectId));
  return { ok: true };
}
