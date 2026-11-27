import { redirect } from "next/navigation";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { scorerHref } from "@/lib/views/scorers/paths";
import { resolveScorersPage } from "../../context";

export const dynamic = "force-dynamic";

/**
 * A scorer is edited in a Panel on its own page, so an old edit link opens that page. The flag and
 * the database are checked first, as on every Scorers page: off, not found; no database, the notice.
 */
export default async function EditScorerPage({
  params,
}: {
  params: Promise<{ projectId: string; scorerId: string }>;
}) {
  const { projectId: rawProjectId, scorerId } = await params;
  const page = await resolveScorersPage(rawProjectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Edit scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  redirect(scorerHref(page.projectId, scorerId));
}
