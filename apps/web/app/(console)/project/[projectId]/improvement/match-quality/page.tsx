import { permanentRedirect } from "next/navigation";
import { qualityTabHref } from "@/lib/views/quality/model";

/** Match quality's score and rewrites live on Quality › Descriptions. */
export default async function MatchQualityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(qualityTabHref(projectId, "descriptions"));
}
