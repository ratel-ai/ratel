import { permanentRedirect } from "next/navigation";
import { fixHref, legacyCraftPeek } from "@/lib/views/fixes/href";

/**
 * Tool craft's Suggestions tab moved to Fixes, where every change is one
 * list. An open suggestion (`?peek=<id>`) opens the same change there; the
 * kinds guide and the scope do not carry over.
 */
export default async function ToolCraftSuggestionsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(fixHref(projectId, { peek: legacyCraftPeek(query.peek) }));
}
