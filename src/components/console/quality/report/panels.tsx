import type { CSSProperties, ReactNode } from "react";
import {
  formatMs,
  LatencyBars,
  RankLegend,
  RankMixChart,
  RateComparison,
  Swatch,
} from "@/components/console/quality/report/charts";
import { fmtCompact, fmtInt, fmtPct } from "@/components/console/quality/report/format";
import {
  armColor,
  type QualitySurface,
  qualityTokens,
} from "@/components/console/quality/report/theme";
import type { CatalogInventory } from "@/lib/ingest/runtime-catalog/inventory";
import { CONFIDENT_SCORE_RATIO } from "@/lib/readings/stats";
import {
  type EvidenceTier,
  type FollowThroughReport,
  TIER_LABELS,
} from "@/lib/synthesis/quality/ground-truth";
import type { CoverageScore, ListCost, UnifiedScore } from "@/lib/synthesis/quality/metrics";
import type { ArmLatency, TierQuality } from "@/lib/synthesis/quality/service";
import {
  BASIS_NOTES,
  projectMonthly,
  SAVINGS_BASELINE,
  SAVINGS_BASELINE_NOTE,
  type TokenSavings,
} from "@/lib/synthesis/quality/tokens";

/**
 * The composed quality panels, shared by the admin console and the PDF report.
 *
 * They render identically on both surfaces because they read `--q-*` tokens
 * rather than palette classes; {@link QualityScope} decides which values those
 * resolve to. Anything genuinely surface-specific, such as the console's cards
 * or the report's page furniture, stays in the page that composes these.
 */

export function QualityScope({
  surface,
  className,
  style,
  children,
}: {
  surface: QualitySurface;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `q-scope ${className}` : "q-scope"}
      style={{ ...qualityTokens(surface), ...style }}
    >
      {children}
    </div>
  );
}

/**
 * The headline: containment and quality, side by side, for one arm.
 *
 * Two numbers rather than one because they fail differently. Containment says
 * whether retrieval found the tool at all; quality says whether it put it
 * somewhere the agent would look. Averaging them into a single figure would
 * hide which one moved, which is the only thing an operator can act on.
 */
export function QualityHeadline({
  containment,
  quality,
  n,
  interval,
  containmentSubtitle,
  qualitySubtitle,
}: {
  containment: number | null;
  quality: number | null;
  n: number;
  interval?: { low: number; high: number } | null;
  containmentSubtitle?: ReactNode;
  qualitySubtitle?: ReactNode;
}) {
  return (
    <div className="q-headline">
      <div className="q-headline-cell">
        <div className="q-headline-label">Containment</div>
        <div className="q-headline-value">{containment === null ? "—" : fmtPct(containment)}</div>
        <div className="q-headline-sub">
          {containmentSubtitle ?? (
            <>
              The right tool was somewhere in the list.
              {interval && (
                <>
                  {" "}
                  {fmtPct(interval.low)}&ndash;{fmtPct(interval.high)} at 95%.
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="q-headline-cell">
        <div className="q-headline-label">Quality</div>
        <div className="q-headline-value">{quality === null ? "—" : fmtPct(quality)}</div>
        <div className="q-headline-sub">
          {qualitySubtitle ?? (
            <>
              Containment, with a bonus for rank. Rank 1 counts 1.00, rank 2 0.82, rank 3 0.75. Over{" "}
              {fmtInt(n)} search{n === 1 ? "" : "es"}.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The headline: one score per arm, and the evidence that produced it.
 *
 * The mix is not a footnote. A blended score is only comparable against another
 * blend of a similar mix, so a partner switching more traffic to attributed
 * invocations would move this number with nothing about retrieval having
 * changed. Printing the split beside the figure is what stops that reading as a
 * quality result.
 */
export function UnifiedPanel({
  unified,
  arms,
  baselineArm,
}: {
  unified: ReadonlyMap<string, UnifiedScore>;
  arms: readonly string[];
  baselineArm: string | null;
}) {
  const rows = arms
    .filter((arm) => unified.get(arm))
    .map((arm) => ({ arm, score: unified.get(arm)! }));
  if (rows.length === 0) return null;

  return (
    <div>
      <RateComparison
        rows={rows.map((row) => ({
          label: row.arm === baselineArm ? `${row.arm} (baseline)` : row.arm,
          value: row.score.score,
          color: armColor(row.arm, baselineArm),
          meta: `${fmtInt(row.score.n)} searches`,
        }))}
      />
      <dl style={{ margin: "6px 0 0" }}>
        {rows.map((row) => (
          <div key={row.arm} className="q-stat-row">
            <dt>{row.arm} evidence</dt>
            <dd>
              {fmtInt(row.score.revealedN)} from what the agent ran
              {row.score.revealedScore !== null && <> ({fmtPct(row.score.revealedScore)})</>} ·{" "}
              {fmtInt(row.score.judgedN)} from the answer key
              {row.score.judgedScore !== null && <> ({fmtPct(row.score.judgedScore)})</>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="q-note" style={{ marginTop: 8 }}>
        Each search is scored against a known answer: the tool the agent actually ran where that is
        known, otherwise the answer key&rsquo;s tool for the request. A search with neither is left
        out rather than scored against {baselineArm ?? "the baseline"}&rsquo;s list. Read the blend
        against another window only when the split above is similar, since more attributed
        invocations move this figure on their own.
      </p>
    </div>
  );
}

/**
 * How often each serving arm's search led the agent to run anything.
 *
 * Shown next to the quality figures rather than folded into them. Plenty of
 * searches end without a tool call for reasons retrieval has no part in, so this
 * is not a quality score. But the scored population contains only searches the
 * agent acted on, and a serving arm whose searches are abandoned far more often
 * is the clearest available evidence that its lists are worse: evidence that
 * scoring throws away by construction.
 */
export function FollowThroughPanel({
  followThrough,
  baselineArm,
}: {
  followThrough: FollowThroughReport;
  baselineArm: string | null;
}) {
  if (followThrough.arms.length === 0) return null;

  if (!followThrough.measurable) {
    return (
      <p className="q-note">
        Not measurable here. No search in this window carries an invocation, so there is no way to
        tell a search the agent abandoned from one whose follow-up was never reported. Every arm
        would read 0%, which would be the most alarming and least true figure on this page.
      </p>
    );
  }

  return (
    <div>
      <RateComparison
        rows={followThrough.arms.map((row) => ({
          label: row.arm,
          value: row.rate,
          color: armColor(row.arm, baselineArm),
          meta: `${fmtInt(row.served)} served`,
        }))}
      />
      <p className="q-note" style={{ marginTop: 2 }}>
        Share of the searches each arm served where the agent then ran a tool. Not a quality score
        on its own: many searches end without a call for reasons retrieval has no part in. It
        matters because only the searches that WERE followed up on can be scored, so an arm whose
        lists get abandoned has its failures quietly dropped from every other figure here.
      </p>
    </div>
  );
}

/** Both arms of one tier, scored over the same population. */
export function TierPanel({ tier, showBias = true }: { tier: TierQuality; showBias?: boolean }) {
  const labels = TIER_LABELS[tier.tier as EvidenceTier];
  if (tier.arms.length === 0) {
    return (
      <p className="q-note">
        No searches in this window are evaluable under the {labels.title.toLowerCase()} tier.{" "}
        {labels.blurb}
      </p>
    );
  }

  return (
    <div>
      <p className="q-note" style={{ marginBottom: 10 }}>
        {labels.blurb}
      </p>
      {tier.note && !tier.comparable && (
        <p className="q-note" style={{ marginBottom: 10, fontWeight: 500 }}>
          {tier.note}
        </p>
      )}

      <RateComparison
        rows={tier.arms.map((arm) => ({
          label: arm.arm === tier.baselineArm ? `${arm.arm} (baseline)` : arm.arm,
          value: arm.score.containment,
          interval: arm.score.containmentInterval,
          color: armColor(arm.arm, tier.baselineArm),
          meta: `${fmtInt(arm.score.n)} searches`,
        }))}
      />
      <p className="q-note" style={{ marginTop: 2 }}>
        The line through each bar is the range the true figure is likely to sit in. Two bars whose
        lines overlap are not yet distinguishable.
      </p>

      {showBias && tier.tier === "revealed" && (
        <div style={{ marginTop: 10 }}>
          {tier.arms.map((arm) => (
            <p key={arm.arm} className="q-note" style={{ marginBottom: 4 }}>
              <strong>{arm.arm}:</strong> {arm.biasNote}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How much of the incumbent's list each arm also returned, and the reverse.
 *
 * Coverage is RECALL against a reference set, and recall is bought by returning
 * more: an arm that returned the whole catalog would cover any list perfectly.
 * Shown on its own it reads as agreement and flatters whichever arm has the
 * longer list. A production tenant's numbers are the case in point, where we
 * cover 88% of a list averaging 1.8 items while returning 4.2 ourselves, and
 * only 41% of what we return appears in theirs.
 *
 * So both directions are drawn on one axis, and the same-first rate sits beside
 * them. That last figure is what a reader usually means by "do we agree": it is
 * symmetric and cannot be bought with length.
 */
export function CoveragePanel({
  coverage,
  arms,
  baselineArm,
}: {
  coverage: ReadonlyMap<string, CoverageScore>;
  arms: readonly string[];
  baselineArm: string | null;
}) {
  const rows = arms
    .filter((arm) => arm !== baselineArm && coverage.get(arm))
    .map((arm) => ({ arm, score: coverage.get(arm)! }));
  if (rows.length === 0) return null;
  const them = baselineArm ?? "the baseline";

  return (
    <div>
      <RateComparison
        rows={rows.flatMap((row) => [
          {
            label: `${row.arm} has theirs`,
            value: row.score.weighted,
            color: armColor(row.arm, baselineArm),
            meta: `${fmtInt(row.score.n)} comparisons`,
          },
          {
            label: `${them} has ours`,
            value: row.score.precision,
            color: armColor(them, baselineArm),
            meta: "the reverse direction",
          },
        ])}
      />
      <dl style={{ margin: "6px 0 0" }}>
        {rows.map((row) => (
          <div key={row.arm} className="q-stat-row">
            <dt>Same first result</dt>
            <dd>
              <strong>{row.score.sameFirst === null ? "—" : fmtPct(row.score.sameFirst)}</strong> ·
              lists of {row.score.averageOurSize?.toFixed(1) ?? "—"} against{" "}
              {row.score.averageReferenceSize?.toFixed(1) ?? "—"} ·{" "}
              {row.score.completeShare === null ? "—" : fmtPct(row.score.completeShare)} of their
              lists fully reproduced
            </dd>
          </div>
        ))}
      </dl>
      <p className="q-note" style={{ marginTop: 8 }}>
        <strong>Read the two bars together.</strong> Covering their list is recall, and recall is
        bought by returning more, so a high figure means little on its own when ours is the longer
        list. The same-first rate is the symmetric one, and it is the number a reader usually means
        by &ldquo;do we agree&rdquo;. None of this is accuracy: if {them} is wrong, matching {them}{" "}
        is wrong too.
      </p>
    </div>
  );
}

/** How high each arm ranked the tool, as a share of its searches. */
export function RankPanel({ tier }: { tier: TierQuality }) {
  const rows = tier.arms
    .filter((arm) => arm.score.n > 0)
    .map((arm) => ({
      label: arm.arm === tier.baselineArm ? `${arm.arm} (baseline)` : arm.arm,
      histogram: arm.score.rankHistogram,
      total: arm.score.n,
    }));
  if (rows.length === 0) return null;

  return (
    <div>
      <RankLegend />
      <RankMixChart rows={rows} />
    </div>
  );
}

/** How long each arm took, and by how much one beats the other. */
export function LatencyPanel({
  latency,
  arms,
  baselineArm,
  speedup,
}: {
  latency: ReadonlyMap<string, ArmLatency>;
  arms: readonly string[];
  baselineArm: string | null;
  speedup?: number | null;
}) {
  const rows = arms.map((arm) => ({
    arm,
    ms: latency.get(arm)?.p50Ms ?? null,
    color: armColor(arm, baselineArm),
  }));

  return (
    <div>
      {speedup != null && (
        <div className="q-figures">
          <div className="q-figure">
            <div className="q-figure-n">{speedup.toFixed(speedup >= 10 ? 0 : 1)}&times;</div>
            <div className="q-figure-l">
              faster than {baselineArm ?? "the baseline"}, at the median
            </div>
          </div>
        </div>
      )}
      <LatencyBars rows={rows} />
      <dl style={{ margin: "10px 0 0" }}>
        {arms.map((arm) => {
          const stats = latency.get(arm);
          return (
            <div key={arm} className="q-stat-row">
              <dt>{arm} p95</dt>
              <dd>
                {formatMs(stats?.p95Ms ?? null)}
                {stats?.errorRate != null && stats.errorRate > 0 && (
                  <> · {fmtPct(stats.errorRate, 1)} errors</>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="q-note" style={{ marginTop: 8 }}>
        Median per arm, taken from each arm&rsquo;s own recorded duration on the same request. That
        is the only figure that isolates one arm: a span covers whatever else the trace was doing.
      </p>
    </div>
  );
}

/**
 * What the list costs beyond whether it was right.
 *
 * Kept out of the quality number on purpose. Weighting a padding penalty against
 * rank credit is a judgement call, and a judgement call inside a headline metric
 * is how a meter starts saying whatever we last wanted it to say.
 */
export function ListCostPanel({
  listCost,
  arms,
  baselineArm,
}: {
  listCost: ReadonlyMap<string, ListCost>;
  arms: readonly string[];
  baselineArm: string | null;
}) {
  return (
    <div>
      <dl style={{ margin: 0 }}>
        {arms.map((arm) => {
          const cost = listCost.get(arm);
          if (!cost) return null;
          return (
            <div key={arm} className="q-stat-row">
              <dt>{arm}</dt>
              <dd>
                {cost.averageReturned === null ? "—" : `${cost.averageReturned.toFixed(1)} results`}
                {cost.fillRate !== null && (
                  <> · fills the limit {fmtPct(cost.fillRate)} of the time</>
                )}
                {cost.confidentShare !== null && <> · {fmtPct(cost.confidentShare)} confident</>}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="q-note" style={{ marginTop: 8 }}>
        &ldquo;Confident&rdquo; is the share of returned results scoring within{" "}
        {CONFIDENT_SCORE_RATIO.toFixed(2)} of the leader. The rest is the tail the agent paid for
        and probably should not have been shown. An arm that fills the requested limit on nearly
        every search is padding; {baselineArm ? `${baselineArm} ` : "a threshold-cutting arm "}
        cutting at a score gap returns fewer, stronger results.
      </p>
    </div>
  );
}

/**
 * Tokens and money, led by the figure a partner repeats out loud.
 *
 * The monthly run rate goes first because "we would stop sending 90 million
 * tokens a month" is the sentence that lands; the per-search arithmetic behind
 * it follows for anyone who wants to check it. The projection is labelled as a
 * projection on the same line, so leading with it does not overstate it.
 */
export function SavingsPanel({
  savings,
  arm,
  windowDays,
}: {
  savings: TokenSavings;
  arm: string;
  windowDays: number;
}) {
  const monthly = projectMonthly(savings, windowDays);

  return (
    <div>
      {monthly && (
        <div className="q-figures">
          <div className="q-figure">
            <div className="q-figure-n">{fmtCompact(monthly.tokensPerMonth)}</div>
            <div className="q-figure-l">
              prompt tokens a month {savings.realized ? "saved" : "avoidable"} against{" "}
              {SAVINGS_BASELINE}, at this volume
            </div>
          </div>
          <div className="q-figure">
            <div className="q-figure-n">
              $
              {monthly.usdPerMonth < 10
                ? monthly.usdPerMonth.toFixed(2)
                : fmtCompact(Math.round(monthly.usdPerMonth))}
            </div>
            <div className="q-figure-l">
              a month against {SAVINGS_BASELINE}, at ${savings.pricePerMtok} per million input
              tokens
            </div>
          </div>
        </div>
      )}

      <dl style={{ margin: 0 }}>
        <div className="q-stat-row">
          <dt>Whole catalog in the prompt</dt>
          <dd>{fmtCompact(savings.fullCatalogTokens)} tokens</dd>
        </div>
        <div className="q-stat-row">
          <dt>With {arm} retrieving</dt>
          <dd>{fmtCompact(savings.servedTokens)} tokens</dd>
        </div>
        <div className="q-stat-row">
          <dt>
            {savings.realized ? "Saved" : "Would save"} per search, against {SAVINGS_BASELINE}
          </dt>
          <dd>
            {fmtCompact(savings.savedPerSearch)} tokens · {fmtPct(savings.savedShare)}
          </dd>
        </div>
        {monthly && (
          <div className="q-stat-row">
            <dt>Search rate in this window</dt>
            <dd>{Math.round(monthly.searchesPerDay)} a day</dd>
          </div>
        )}
      </dl>

      {!savings.realized && (
        <p className="q-note" style={{ marginTop: 8 }}>
          <strong>Nothing is banked yet:</strong> {arm} only shadowed over this window, so this is
          what the same traffic would save once it serves.
        </p>
      )}
      <p className="q-note" style={{ marginTop: 6 }}>
        <strong>{SAVINGS_BASELINE_NOTE}</strong> {BASIS_NOTES[savings.basis]} The monthly figures
        are a projection of this window&rsquo;s rate over 30 days.
      </p>
    </div>
  );
}

/** The corpus behind the number: how many information points we have. */
export function CatalogInventoryPanel({
  inventory,
  fingerprintChanges,
}: {
  inventory: CatalogInventory;
  fingerprintChanges?: number;
}) {
  return (
    <div>
      <dl style={{ margin: 0 }}>
        <div className="q-stat-row">
          <dt>Capabilities indexed</dt>
          <dd>{fmtInt(inventory.entryCount)}</dd>
        </div>
        <div className="q-stat-row">
          <dt>Searchable text</dt>
          <dd>{fmtCompact(inventory.searchableChars)} characters</dd>
        </div>
        <div className="q-stat-row">
          <dt>Distinct from the agent description</dt>
          <dd>
            {fmtInt(inventory.distinctCount)}
            {inventory.entryCount > 0 && (
              <> · {fmtPct(inventory.distinctCount / inventory.entryCount)}</>
            )}
          </dd>
        </div>
        <div className="q-stat-row">
          <dt>Carrying a Cloud override</dt>
          <dd>{fmtInt(inventory.overriddenCount)}</dd>
        </div>
        {fingerprintChanges !== undefined && (
          <div className="q-stat-row">
            <dt>Corpus changes in this window</dt>
            <dd>{fmtInt(fingerprintChanges)}</dd>
          </div>
        )}
        <div className="q-stat-row">
          <dt>Fingerprint</dt>
          <dd style={{ fontFamily: "var(--font-mono), monospace", fontSize: 11 }}>
            {inventory.fingerprint.slice(0, 12)}
          </dd>
        </div>
      </dl>
      <p className="q-note" style={{ marginTop: 8 }}>
        The fingerprint hashes what retrieval matches on, meaning the searchable text with overrides
        included, so it moves only when ranking could genuinely have changed. Re-syncing an
        identical corpus does not move it.
      </p>
    </div>
  );
}

/**
 * Colour key, so a reader learns it once.
 *
 * `baselineNote` exists because the incumbent arm is called different things to
 * different readers: "baseline" in the console, "yours" in a partner's report.
 * The word has to match whatever the charts above it used, or the legend reads
 * as a third series.
 */
export function ArmLegend({
  arms,
  baselineArm,
  baselineNote = "baseline",
}: {
  arms: readonly string[];
  baselineArm: string | null;
  baselineNote?: string;
}) {
  return (
    <div className="q-legend">
      {arms.map((arm) => (
        <span key={arm}>
          <Swatch color={armColor(arm, baselineArm)} />
          {arm}
          {arm === baselineArm && ` (${baselineNote})`}
        </span>
      ))}
    </div>
  );
}
