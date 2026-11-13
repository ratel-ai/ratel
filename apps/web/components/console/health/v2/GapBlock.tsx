import { buttonVariants } from "@ratel/design-system/button-variants";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Shuffle, Wrench } from "lucide-react";
import type { PageGap } from "@/components/console/health/data-gaps-model";
import { previewCopy } from "@/components/console/health/section-preview-model";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { setupPeek } from "@/components/console/health/v2/setup-peek";

/**
 * When runs cannot carry the run-based sections (no tool call recorded, or
 * calls from different users mixed in one run), one block stands in for turn
 * shapes, tasks and the call order: what is missing and how to send it.
 */
export function GapBlock({ gap, lane }: { gap: PageGap; lane: "sdk" | "otel" }) {
  const copy = previewCopy(gap, lane);
  return (
    <Section title={<NounTitle noun="task">Tasks that need a look</NounTitle>} className="min-w-0">
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
