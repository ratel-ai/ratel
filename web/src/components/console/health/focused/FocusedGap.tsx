import { buttonVariants } from "@ratel/design-system/button-variants";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Shuffle, Wrench } from "lucide-react";
import { previewCopy } from "@/components/console/health/section-preview-model";
import { setupPeek } from "@/components/console/health/v2/setup-peek";
import type { PageGap } from "@/lib/views/health/data-gaps-model";

/** In place of the score when the runs cannot carry one: what is missing and how to send it. */
export function FocusedGap({ gap, lane }: { gap: PageGap; lane: "sdk" | "otel" }) {
  const copy = previewCopy(gap, lane);
  return (
    <Section title="Health score">
      <div className="rounded-lg border border-line" data-health-gap={gap}>
        <EmptyState
          icon={gap === "mixed_runs" ? Shuffle : Wrench}
          title={copy.title}
          description={copy.body}
          action={
            <PeekLink
              peek={setupPeek(copy.setupKey)}
              className={buttonVariants({ variant: "secondary" })}
            >
              {copy.action}
            </PeekLink>
          }
        />
      </div>
    </Section>
  );
}
