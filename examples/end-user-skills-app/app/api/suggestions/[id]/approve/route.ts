import { CloudApiError } from "@ratel-ai/cloud";
import { getCloud } from "@/lib/ratel";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const suggestion = await getCloud().suggestions.approve(id);
    return Response.json({ suggestion });
  } catch (err) {
    const status = err instanceof CloudApiError ? err.status : 500;
    const message = err instanceof Error ? err.message : "approve failed";
    return Response.json({ error: message }, { status });
  }
}
