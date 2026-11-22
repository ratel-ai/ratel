import { QualitySkeleton } from "@/components/console/quality/QualitySkeleton";

/** The index only redirects to Quality > Experiments; the detail routes below bring their own loading state. */
export default function CalibrationLoading() {
  return <QualitySkeleton />;
}
