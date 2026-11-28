import { type FeatureName, withFeatureSpan } from "@/lib/contracts/feature-spans";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";

/** Who may call the session routes of a feature: members of the project's organization. */
export type MemberAccessDeps = {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string }; role: string } | null>;
  /** An admin support session may look but not change. */
  isRestricted: () => Promise<boolean>;
};

export type Member = {
  projectId: string;
  organizationId: string;
  externalId: string;
  role: string;
};

/** Runs `work` for a member. Another person gets 404. */
export async function forMember(
  projectId: string,
  span: { feature: FeatureName; operation: string },
  deps: MemberAccessDeps,
  work: (member: Member) => Promise<Response>,
  { write = false }: { write?: boolean } = {},
): Promise<Response> {
  const session = await deps.getSession();
  if (!session) return refuse(401, "signed_out", "Sign in first.");
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) {
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
  return withFeatureSpan(span.feature, span.operation, () => work(member), {
    attributes: { "project.id": member.projectId },
  });
}

export function refuse(status: number, error: string, message: string): Response {
  return reply(status, { error, message });
}

export function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
