import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import { type RouteSearchParams, sentinelDestination } from "@/lib/console/scope/sentinel";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";

export default async function ProjectSentinelPage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<RouteSearchParams>;
}) {
  if (!isDbConfigured()) redirect("/organizations");

  const [cookieStore, { path }, query, context] = await Promise.all([
    cookies(),
    params,
    searchParams,
    getSessionContext(),
  ]);
  if (!context) redirect("/");
  redirect(
    await sentinelDestination(
      cookieStore.get(LAST_PROJECT_COOKIE)?.value,
      path,
      query,
      context.user.id,
    ),
  );
}
