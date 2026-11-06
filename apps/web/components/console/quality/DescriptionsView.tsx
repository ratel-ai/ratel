import { DotMeter, DotSpark } from "@ratel/design-system/dot-matrix";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { Projection } from "@/lib/views/quality/descriptions";
import { type Headline, TIER_LABEL } from "@/lib/views/quality/headline";
import type { DescriptionsData } from "@/lib/views/quality/load-descriptions";
import type { QualityEvidence, TheirRanking } from "@/lib/views/quality/load-misses";
import { NO_VALUE, percent, plural } from "@/lib/views/quality/model";
import { RewritesList } from "./RewritesList";
import { LoadFailed, UpgradeState } from "./states";

/**
 * Quality › Descriptions: how often the right tool is found at all (the number
 * a searchable description moves), beside the customer's own ranking when an
 * experiment runs one, and the rewrites that would find it more often, each
 * with its before and after and its replay. Other pages link here for a
 * description update (`?tool=`, `?peek=rewrite:`).
 */
export function DescriptionsView({
  projectId,
  evidence,
  data,
  locked,
  billingHref,
  analyse,
  windowPhrase,
  versusPhrase,
  now,
}: {
  projectId: string;
  /** The header's read: the score. Null when it failed. */
  evidence: QualityEvidence | null;
  /** Null when the rewrites could not be read. */
  data: DescriptionsData | null;
  locked: boolean;
  billingHref: string | null;
  /** The run menu, as the empty state's one action. */
  analyse?: ReactNode;
  windowPhrase: string;
  versusPhrase: string;
  now: Date;
}) {
  if (locked) return <UpgradeState billingHref={billingHref} />;
  if (data === null) return <LoadFailed what="rewrites" />;

  const phase = data.run?.phase ?? null;
  const hasRewrites = data.pending.length > 0 || data.applied.length > 0;
  return (
    <div className="flex flex-col gap-8" data-tab="descriptions">
      {evidence ? (
        <Score
          evidence={evidence}
          projection={data.projection}
          windowPhrase={windowPhrase}
          versusPhrase={versusPhrase}
        />
      ) : (
        <LoadFailed what="the score" />
      )}
      {phase === "failed" ? (
        <Callout tone="danger" title="The last analysis didn't finish">
          Start another from Analyse searches.
        </Callout>
      ) : null}
      {hasRewrites ? null : (
        <div className="rounded-lg border border-line">
          {emptyState(phase, data.run?.declinedReason ?? null, analyse)}
        </div>
      )}
      <RewritesList
        projectId={projectId}
        pending={data.pending}
        applied={data.applied}
        overridesAdopted={data.overridesAdopted}
        experimentName={data.experimentName}
        toolCard={data.tool}
        windowPhrase={windowPhrase}
        now={now.toISOString()}
      />
    </div>
  );
}

/** "Right tool found 80%", the customer's own ranking beside it, and what applying every rewrite does. */
function Score({
  evidence,
  projection,
  windowPhrase,
  versusPhrase,
}: {
  evidence: QualityEvidence;
  projection: Projection | null;
  windowPhrase: string;
  versusPhrase: string;
}) {
  const { found, theirs } = evidence;
  const stats: StatProps[] = [foundStat(found, windowPhrase, versusPhrase)];
  if (theirs) stats.push(theirStat(theirs, found));
  if (projection) stats.push(projectionStat(projection));
  if (stats.length === 1 && found.share === null) return null;
  return (
    <section aria-label="How often the right tool is found" data-score="found">
      <StatRow stats={stats} />
    </section>
  );
}

function foundStat(found: Headline, windowPhrase: string, versusPhrase: string): StatProps {
  const trend = found.share !== null && found.trend.filter((point) => point !== null).length >= 2;
  return {
    label: "Right tool found",
    value: found.share === null ? NO_VALUE : percent(found.share),
    delta: found.change
      ? {
          value: found.change.text,
          direction: found.change.direction,
          good: found.change.direction === "up",
          label: versusPhrase,
        }
      : undefined,
    hint:
      found.tier === null
        ? "No judged searches yet"
        : found.share === null
          ? `${TIER_LABEL[found.tier]}: ${plural(found.n, "search", "searches")}, 10 needed`
          : `${TIER_LABEL[found.tier]} on ${plural(found.n, "search", "searches")}`,
    trend: trend ? (
      <DotSpark
        values={found.trend}
        tone="neutral"
        label={`Right tool found per ${found.trendUnit}, ${windowPhrase}. Blank ${found.trendUnit}s had too few searches.`}
      />
    ) : undefined,
  };
}

/** The customer's own ranking, measured the same way, with both shares drawn side by side. */
function theirStat(theirs: TheirRanking, ours: Headline): StatProps {
  return {
    label: "Your own ranking",
    value: theirs.found.share === null ? NO_VALUE : percent(theirs.found.share),
    // "Yours" names it; the variant's own key stays off the page.
    hint: `First ${percent(theirs.first.share)}`,
    trend:
      theirs.found.share !== null && ours.share !== null ? (
        <span className="flex flex-col gap-1.5 max-sm:hidden" data-compare="found">
          <CompareLine name="Ratel" share={ours.share} />
          <CompareLine name="Yours" share={theirs.found.share} />
        </span>
      ) : undefined,
  };
}

/** One share as pixels with its name and number beside it (direct labels, no legend). */
function CompareLine({ name, share }: { name: string; share: number }) {
  return (
    <span className="flex items-center gap-2 text-xs text-fg-subtle">
      <span className="w-10 shrink-0">{name}</span>
      <DotMeter
        value={share}
        cells={20}
        tone="neutral"
        label={`${name}: right tool found ${percent(share)}`}
      />
      <span className="tabular-nums text-fg-muted">{percent(share)}</span>
    </span>
  );
}

function projectionStat(projection: Projection): StatProps {
  return {
    label: `If you apply all ${projection.pending}`,
    value: projection.delta,
    hint: projection.significant
      ? "Found in a replay of past searches"
      : "Found in a replay of past searches, within its margin",
  };
}

function emptyState(phase: string | null, declined: string | null, analyse: ReactNode) {
  if (phase === "queued" || phase === "running") {
    return (
      <EmptyState
        emblem
        title="Analysing your searches"
        description="Rewrites show up here when it finishes, usually within a few minutes."
      />
    );
  }
  if (phase === "analyzed") {
    return (
      <EmptyState
        icon={CircleCheck}
        title="No rewrites to review"
        description={declined ?? "The last analysis found no description worth rewriting."}
        action={analyse}
      />
    );
  }
  return (
    <EmptyState
      emblem
      title="No rewrites yet"
      description="An analysis reads your recent searches and drafts a rewrite for each tool they missed."
      action={analyse}
    />
  );
}
