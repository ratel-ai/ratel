import { evalsPage } from "../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

/** How each eval scores over its runs: the chart, then the evals. `?new=1` opens "New eval". */
export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ new?: string | string[] }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  return evalsPage(projectId, query.new === "1");
}
