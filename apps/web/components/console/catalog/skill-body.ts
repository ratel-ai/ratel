export type SkillBodyResult = { ok: true; body: string } | { ok: false; error: string };

export type SkillBodyLoader = (id: string) => Promise<SkillBodyResult>;

const LOAD_FAILED = "Couldn't load the instructions. Try again in a moment.";

/**
 * A Cloud skill's SKILL.md body, read through the existing account-authed
 * `GET /api/skills-catalog/<id>`. A failure resolves to words for the reader;
 * nothing throws.
 */
export async function fetchSkillBody(id: string): Promise<SkillBodyResult> {
  let response: Response;
  try {
    response = await fetch(`/api/skills-catalog/${encodeURIComponent(id)}`);
  } catch {
    return { ok: false, error: LOAD_FAILED };
  }
  const json = (await response.json().catch(() => null)) as { body?: unknown } | null;
  if (!response.ok || typeof json?.body !== "string") return { ok: false, error: LOAD_FAILED };
  return { ok: true, body: json.body };
}
