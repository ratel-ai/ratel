import { IntentsSkeleton } from "@/components/console/intents/IntentsSkeleton";
import { MAP_DESCRIPTION } from "@/components/console/intents/MapView";

export default function MapLoading() {
  return <IntentsSkeleton title="Map" description={MAP_DESCRIPTION} canvas />;
}
