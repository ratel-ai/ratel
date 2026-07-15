import { getCloud, getUserRuntime } from "@/lib/ratel";

export const runtime = "nodejs";
// Flush → categorize → generate runs Cloud's pipeline synchronously,
// including a real model call to draft any proposed skill.
export const maxDuration = 300;

/**
 * The "analyze my usage" button: push this user's buffered trace events to
 * Cloud, force the categorization pass (bypasses the ~hourly cron throttle),
 * run suggestion generation, and return the pending per-user proposals.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { user?: string } | null;
  if (!body?.user) return Response.json({ error: "Missing user." }, { status: 400 });

  const cloud = getCloud();
  const rt = await getUserRuntime(body.user);

  await rt.exporter.flush();
  await cloud.categorizeQueries();
  await cloud.suggestions.generate();

  const { suggestions } = await cloud.suggestions.list({ status: "pending", type: "new_skill" });
  return Response.json({ suggestions: suggestions.filter((s) => s.endUserId === body.user) });
}
