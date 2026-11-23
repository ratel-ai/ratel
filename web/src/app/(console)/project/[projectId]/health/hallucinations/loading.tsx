import { HALLUCINATIONS_DESCRIPTION } from "@/components/console/hallucinations/copy";
import { SentimentSkeleton } from "@/components/console/sentiment/SentimentSkeleton";

export default function HallucinationsLoading() {
  return <SentimentSkeleton title="Hallucinations" description={HALLUCINATIONS_DESCRIPTION} />;
}
