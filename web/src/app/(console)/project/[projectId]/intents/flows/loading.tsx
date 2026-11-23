import { FLOWS_DESCRIPTION } from "@/components/console/intents/FlowsView";
import { IntentsSkeleton } from "@/components/console/intents/IntentsSkeleton";

export default function FlowsLoading() {
  return <IntentsSkeleton title="Flows" description={FLOWS_DESCRIPTION} canvas />;
}
