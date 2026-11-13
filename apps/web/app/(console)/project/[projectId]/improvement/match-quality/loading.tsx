import { QualitySkeleton } from "@/components/console/quality/QualitySkeleton";

/** This route only redirects to Quality › Descriptions, so its loading state is that page's. */
export default function MatchQualityLoading() {
  return <QualitySkeleton />;
}
