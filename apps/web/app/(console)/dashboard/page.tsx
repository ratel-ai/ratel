import { redirect } from "next/navigation";
import { dashboardHref } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/**
 * The legacy `/dashboard`. Owned (ADR-0030): upstream's proxy redirects it; here the route does,
 * to the session organization's first project. Temporary, since the target follows the session.
 */
export default async function LegacyDashboardPage() {
  redirect(dashboardHref((await getConsoleScope())?.projects ?? []));
}
