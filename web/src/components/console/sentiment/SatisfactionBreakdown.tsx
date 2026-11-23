import { DotMeter } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import { Smile } from "lucide-react";
import Link from "next/link";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { percent, plural } from "@/components/console/sentiment/copy";
import { SatisfactionFace } from "@/components/console/sentiment/SatisfactionFace";
import type { IntentScoreView, SentimentLinks } from "@/lib/views/traces/sentiment/page-links";

const LINK =
  "min-w-0 flex-1 truncate rounded-sm text-ui text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus";

/**
 * The intents (their level-2 group) people were most and least satisfied
 * with. A score is satisfied of the turns people said how it went in, in
 * their words or as the agent's next reply shows it; neutral turns are left
 * out. An intent narrows the page, so its tasks and reasons show. Shown only
 * when some turn has an answer.
 */
export function SatisfactionBreakdown({ links }: { links: SentimentLinks }) {
  const scores = links.intentScores;
  if (!scores) return null;
  return (
    <Section
      title={<NounTitle icon={Smile}>Satisfaction by intent</NounTitle>}
      description="Turns people did not push back on, of those they reacted to. Pick an intent to see its satisfaction day by day."
    >
      <div
        className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2"
        data-sentiment-satisfaction=""
      >
        <Block title="Most satisfied intents">
          <IntentList
            entries={scores.satisfied}
            fewAnswers={scores.fewAnswers}
            empty="No intent scored above half."
          />
        </Block>
        <Block title="Least satisfied intents">
          <IntentList
            entries={scores.unsatisfied}
            fewAnswers={scores.fewAnswers}
            empty="No intent scored below half."
          />
        </Block>
      </div>
      {[...scores.satisfied, ...scores.unsatisfied].some(
        (entry) => entry.said < scores.fewAnswers,
      ) ? (
        <p className="mt-3 text-xs text-fg-subtle">
          An intent with fewer than {scores.fewAnswers} answers is marked: its score is a hint, not
          a pattern yet.
        </p>
      ) : null}
    </Section>
  );
}

function IntentList({
  entries,
  fewAnswers,
  empty,
}: {
  entries: readonly IntentScoreView[];
  fewAnswers: number;
  empty: string;
}) {
  if (entries.length === 0) return <p className="py-1 text-ui text-fg-subtle">{empty}</p>;
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <li
          key={entry.intent.id}
          className="flex min-h-9 items-center gap-3 border-b border-line py-1"
          data-intent-score={entry.intent.id}
        >
          <Link href={entry.href} scroll={false} className={LINK}>
            {entry.intent.label}
          </Link>
          <Score score={entry.score} said={entry.said} few={entry.said < fewAnswers} />
        </li>
      ))}
    </ul>
  );
}

/** A score with its meter and how many answers it stands on; "None" when nobody said. */
function Score({
  score,
  said,
  few = false,
}: {
  score: number | null;
  said: number;
  few?: boolean;
}) {
  if (score === null) return <span className="text-xs text-fg-subtle">No answers</span>;
  return (
    <span className="flex shrink-0 items-center gap-3">
      <DotMeter value={score} cells={8} label={`${percent(score)} satisfied`} />
      <SatisfactionFace score={score} className="w-16 justify-end text-ui" />
      <span
        className="w-24 text-right text-xs text-fg-subtle tabular-nums"
        title={few ? "Few answers: read this score as a hint" : undefined}
      >
        {plural(said, "answer")}
        {few ? " · few" : ""}
      </span>
    </span>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="text-ui font-medium text-fg-muted">{title}</h3>
      {children}
    </div>
  );
}
