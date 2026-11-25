import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";

/** Who may call the session routes of sandboxes: members of the project's organization. */
export type ConsoleAccessDeps = {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string }; role: string } | null>;
  enabled: (projectId: string) => Promise<boolean>;
  /** An admin support session may look but not change. */
  isRestricted: () => Promise<boolean>;
};

export type Member = {
  projectId: string;
  organizationId: string;
  externalId: string;
  role: string;
};

/** Runs `work` for a member. Another person, and a project with the flag off, get 404. */
export async function forMember(
  projectId: string,
  operation: string,
  deps: ConsoleAccessDeps,
  work: (member: Member) => Promise<Response>,
  { write = false }: { write?: boolean } = {},
): Promise<Response> {
  const session = await deps.getSession();
  if (!session) return refuse(401, "signed_out", "Sign in first.");
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope || !(await deps.enabled(scope.project.id))) {
    return refuse(404, "not_found", "No project you belong to has that ID.");
  }
  if (write && (await deps.isRestricted())) {
    return refuse(403, "restricted", SUPPORT_SESSION_RESTRICTED_MESSAGE);
  }
  const member = {
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    externalId: session.user.externalId,
    role: scope.role,
  };
  return withFeatureSpan("sandboxes", operation, () => work(member), {
    attributes: { "project.id": member.projectId },
  });
}

export function refuse(status: number, error: string, message: string): Response {
  return reply(status, { error, message });
}

export function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
