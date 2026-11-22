import { QualitySkeleton } from "@/components/console/quality/QualitySkeleton";

/** Every Quality tab loads behind the same skeleton: header, headline, tabs and a list. */
export default function QualityLoading() {
  return <QualitySkeleton />;
}
