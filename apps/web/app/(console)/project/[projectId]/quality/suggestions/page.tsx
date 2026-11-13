import { permanentRedirect } from "next/navigation";
import { descriptionsHref, legacySuggestionId } from "@/lib/views/quality/model";

/**
 * Quality's Suggestions are its Descriptions now: the same rewrites, with
 * Apply, Dismiss and Revert, beside the score they move. An open rewrite
 * (`?peek=<id>`) opens there too.
 */
export default async function QualitySuggestionsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(descriptionsHref(projectId, { rewrite: legacySuggestionId(query.peek) }));
}
