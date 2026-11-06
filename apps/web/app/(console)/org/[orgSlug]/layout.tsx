import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";

/** One organization per session: any other slug is a 404, never a page. */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) return children;
  const [{ orgSlug }, scope] = await Promise.all([params, getConsoleScope()]);
  if (!scope || scope.organizationSlug !== orgSlug) notFound();
  return children;
}
