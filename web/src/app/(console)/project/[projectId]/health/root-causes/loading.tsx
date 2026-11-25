import { ROOT_CAUSE_DESCRIPTION } from "@/components/console/sentiment/copy";
import { SentimentSkeleton } from "@/components/console/sentiment/SentimentSkeleton";

export default function RootCauseLoading() {
  return (
    <SentimentSkeleton
      title="Root cause analysis"
      description={ROOT_CAUSE_DESCRIPTION}
      parent="health"
    />
  );
}
