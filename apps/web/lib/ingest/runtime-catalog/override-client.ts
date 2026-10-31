import type { RuntimeCatalogKind } from "./override-handler";

type OverrideResult =
  | { ok: true; searchableDescription: string | null }
  | { ok: false; error: string };

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Call the session-authenticated runtime-catalog override endpoint. */
export async function updateRuntimeCatalogOverride(
  fetcher: Fetch,
  input: {
    /** The project uuid — slugs are unique per organization, not globally. */
    projectId: string;
    kind: RuntimeCatalogKind;
    entryId: string;
    searchableDescription: string | null;
  },
): Promise<OverrideResult> {
  const query = new URLSearchParams({ project: input.projectId });
  const response = await fetcher(
    `/api/runtime-catalog/${input.kind}/${encodeURIComponent(input.entryId)}?${query}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        searchableDescription: input.searchableDescription,
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    searchableDescription?: unknown;
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      error:
        typeof body?.error === "string" ? body.error : "Couldn’t update the retrieval description.",
    };
  }
  return {
    ok: true,
    searchableDescription:
      typeof body?.searchableDescription === "string" ? body.searchableDescription : null,
  };
}
