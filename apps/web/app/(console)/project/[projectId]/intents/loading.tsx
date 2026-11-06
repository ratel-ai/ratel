import { IntentsSkeleton } from "@/components/console/intents/IntentsSkeleton";
import { INTENTS_TITLE } from "@/components/console/intents/TopicsView";

export default function IntentsLoading() {
  return <IntentsSkeleton title={INTENTS_TITLE} />;
}
