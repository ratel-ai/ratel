import { notFound, redirect } from "next/navigation";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";
import { variantExperimentsEnabled } from "@/lib/platform/variants-flag";
import { type ResolvedRange, resolveRange } from "@/lib/synthesis/dashboard";
import { boundVariantWindow } from "@/lib/views/variants/compare-service";
import type { VariantWindow } from "@/lib/views/variants/compare-store";
import type { VariantsQuery } from "@/lib/views/variants/paths";

export type VariantsSearchParams = Record<string, string | string[] | undefined>;

export interface VariantsPageContext {
  project: Project;
  organization: Organization;
  externalId: string;
  range: ResolvedRange;
  /** The window read: the range cut to its last 30 days. */
  window: VariantWindow;
  /** True when the range was wider than the window read. */
  clamped: boolean;
  /** What every link of the page keeps. */
  query: VariantsQuery;
}

/**
 * What both Variants pages (RC-871) start from: the signed-in person's project,
 * the flag (`FF_VARIANT_EXPERIMENTS`, decided per project; off, the pages do
 * not exist) and the window (`range`, `from`, `to`, 30 days by default).
 * Owned (ADR-0030): the session and the console's project scope are the core's
 * (`getProjectScope` by project id, a 404 when the reader is not a member).
 */
export async function resolveVariantsPageContext(
  projectId: string,
  searchParams: VariantsSearchParams,
): Promise<VariantsPageContext> {
  const session = await getSessionContext();
  if (!session) redirect("/");
  const { project, organization } = await getProjectScope(projectId);
  if (!(await variantExperimentsEnabled(project.id, organization))) notFound();

  const range = resolveRange({
    range: text(searchParams.range),
    from: text(searchParams.from),
    to: text(searchParams.to),
  });
  const window = boundVariantWindow({ since: range.since, until: range.until });
  return {
    project,
    organization,
    externalId: session.user.externalId,
    range,
    window,
    clamped: window.since.getTime() !== range.since.getTime(),
    query: {
      range: range.preset,
      ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}),
    },
  };
}

function text(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
