import type { ReactNode } from "react";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import { dbConfigured } from "@/lib/platform/db/request";

/** Any organization the reader belongs to opens, as upstream; any other slug is a 404, never a page. */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!(await dbConfigured())) return children;
  const { orgSlug } = await params;
  await requireOrganizationScope(orgSlug);
  return children;
}
