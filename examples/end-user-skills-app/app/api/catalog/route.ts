import { cloudUrl } from "@/lib/ratel";

export const runtime = "nodejs";

/**
 * Proxy of Cloud's `GET /api/v1/catalog` (published, global skills — exactly
 * what SkillSync pulls into every user's live catalog) for the UI panel.
 */
export async function GET() {
  const apiKey = process.env.RATEL_CLOUD_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "RATEL_CLOUD_API_KEY is not configured." }, { status: 503 });
  }
  const res = await fetch(new URL("/api/v1/catalog", cloudUrl()), {
    headers: { authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return Response.json({ error: `Cloud catalog fetch failed (HTTP ${res.status}).` }, { status: 502 });
  }
  const payload = (await res.json()) as {
    catalogVersion: string;
    skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
  };
  return Response.json({
    cloudUrl: cloudUrl(),
    catalogVersion: payload.catalogVersion,
    skills: payload.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
    })),
  });
}
