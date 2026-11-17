import { redirect } from "next/navigation";

export const metadata = { title: "Sessions" };

/**
 * The old Sessions tab address (RC-472). RC-503: Sessions is now the first
 * tab of Traces, so this sends there with the query.
 */
export default async function TracesSessionsTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    for (const item of [value ?? []].flat()) query.append(key, item);
  const text = query.toString();
  redirect(`/project/${encodeURIComponent(projectId)}/traces${text ? `?${text}` : ""}`);
}
