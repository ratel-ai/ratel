import { permanentRedirect } from "next/navigation";
import { calibrationRedirectHref } from "@/lib/views/quality/model";

/**
 * The Calibration index lives on Quality > Experiments; the detail routes
 * below stay where they are. An old link keeps its window and the experiment
 * it asked for.
 */
export default async function ScopedCalibrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(calibrationRedirectHref(projectId, query));
}
