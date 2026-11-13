import { permanentRedirect } from "next/navigation";
import { asksRedirectHref } from "@/lib/views/intents/topics-view";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Asks became Topics. An old link, and the panel it had open, land on Topics;
 * an ask group's id opens nothing there, and the page says what it lists.
 */
export default async function AsksPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const peek = firstParam((await searchParams).peek);
  permanentRedirect(asksRedirectHref(projectId, peek));
}
