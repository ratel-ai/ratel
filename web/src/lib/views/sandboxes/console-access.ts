import * as access from "@/lib/console/scope/member-access";

export {
  type Member,
  type MemberAccessDeps as ConsoleAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";

/** Runs `work` for a member, in a span of the sandboxes feature. */
export function forMember(
  projectId: string,
  operation: string,
  deps: access.MemberAccessDeps,
  work: (member: access.Member) => Promise<Response>,
  options?: { write?: boolean },
): Promise<Response> {
  return access.forMember(projectId, { feature: "sandboxes", operation }, deps, work, options);
}
