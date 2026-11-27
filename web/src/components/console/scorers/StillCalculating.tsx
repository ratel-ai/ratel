import { Hourglass } from "lucide-react";
import { WidgetEmpty } from "@/components/console/home/focused/WidgetEmpty";

/** A scorer with no result yet: it scores only the traces that come after it. */
export function StillCalculating({ padded }: { padded?: boolean }) {
  return (
    <WidgetEmpty
      name="scorer-calculating"
      icon={Hourglass}
      title="Still calculating"
      description="This scorer scores new traces. Its first results appear a minute or two after the next matching trace."
      padded={padded}
    />
  );
}
