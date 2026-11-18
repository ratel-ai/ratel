import type { ReactNode } from "react";
import { requireOrganizationScope } from "@/lib/console/scope/organization-scope";
import { isDbConfigured } from "@/lib/platform/db/client";

/** Any organization the reader belongs to opens, as upstream; any other slug is a 404, never a page. */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) return children;
  const { orgSlug } = await params;
  await requireOrganizationScope(orgSlug);
  return children;
}
