import { DotMeter } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import { MessageSquareQuote } from "lucide-react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { Examples } from "@/components/console/self-corrections/Examples";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { SelfCorrectionsPageModel } from "@/lib/views/health/self-corrections/page-model";

/**
 * What the agent said when it went back on itself: its top phrases, each
 * with a bar and a count, beside example cards whose words are read on
 * demand with the phrase marked. Without content capture the phrases say
 * what they need, and the examples say what happened instead.
 */
export function Said({ model, now }: { model: SelfCorrectionsPageModel; now: string }) {
  const most = Math.max(0, ...model.phrases.top.map((row) => row.events));
  return (
    <Section title={<NounTitle icon={MessageSquareQuote}>What the agent said</NounTitle>}>
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 xl:grid-cols-3" data-corrections-said="">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-ui font-medium text-fg-muted">Top phrases</h3>
          {!model.phrases.captured ? (
            <p className="py-1 text-ui text-fg-subtle">
              Turn on content capture to see what the agent said.
            </p>
          ) : model.phrases.top.length === 0 ? (
            <p className="py-1 text-ui text-fg-subtle">
              The agent did not apologize, concede or backtrack in its replies.
            </p>
          ) : (
            <ul className="flex flex-col" data-corrections-phrases={model.phrases.top.length}>
              {model.phrases.top.map((row) => (
                <li
                  key={row.phrase}
                  className="flex min-h-9 items-center gap-3 border-b border-line py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-ui text-fg">“{row.phrase}”</span>
                  <DotMeter
                    value={most > 0 ? row.events / most : 0}
                    cells={10}
                    tone="neutral"
                    label={`${Math.round(row.share * 100)}% of phrases`}
                    className="shrink-0 max-sm:hidden"
                  />
                  <span className="w-10 shrink-0 text-right text-ui text-fg tabular-nums">
                    {formatCount(row.events)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 xl:col-span-2">
          <h3 className="text-ui font-medium text-fg-muted">Examples</h3>
          <Examples projectId={model.projectId} examples={model.examples} now={now} />
        </div>
      </div>
    </Section>
  );
}
