import { buttonVariants } from "@ratel/design-system/button-variants";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Shuffle, Wrench } from "lucide-react";
import { previewCopy } from "@/components/console/health/section-preview-model";
import { setupPeek } from "@/components/console/health/v2/setup-peek";
import type { PageGap } from "@/lib/views/health/data-gaps-model";

/** Why there is no score, in this page's words (`previewCopy` speaks of the public page's sections). */
const BODY: Readonly<Record<PageGap, string>> = {
  no_tool_calls:
    "The score and the issues start from the tools your agent calls. Send tool calls to see yours here.",
  mixed_runs:
    "Without turn ids, calls from different users land in one run, so a score would be a guess. Send turn ids and it is read from the fixed runs.",
};

/** In place of the score when the runs cannot carry one: what is missing and how to send it. */
export function FocusedGap({ gap, lane }: { gap: PageGap; lane: "sdk" | "otel" }) {
  const copy = previewCopy(gap, lane);
  return (
    <Section title="Health score">
      <div className="rounded-lg border border-line" data-health-gap={gap}>
        <EmptyState
          icon={gap === "mixed_runs" ? Shuffle : Wrench}
          title={copy.title}
          description={BODY[gap]}
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
