import { redirect } from "next/navigation";

/**
 * Where a description is rewritten. The Quality pages are not part of this build yet, so a
 * description fix opens its tool on the Catalog, highlighted when the link names one. A
 * temporary redirect: the page lands under this path.
 */
export default async function DescriptionsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  const tool = typeof search.tool === "string" ? search.tool : null;
  const root = `/project/${encodeURIComponent(projectId)}/catalogs/tools`;
  redirect(
    tool ? `${root}?q=${encodeURIComponent(tool)}&highlight=${encodeURIComponent(tool)}` : root,
  );
}
