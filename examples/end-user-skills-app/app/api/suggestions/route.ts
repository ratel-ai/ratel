import { getCloud } from "@/lib/ratel";

export const runtime = "nodejs";

/** Pending per-user `new_skill` proposals for `?user=` (no generation). */
export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user");
  if (!user) return Response.json({ error: "Missing ?user=" }, { status: 400 });
  const { suggestions } = await getCloud().suggestions.list({
    status: "pending",
    type: "new_skill",
  });
  return Response.json({ suggestions: suggestions.filter((s) => s.endUserId === user) });
}
