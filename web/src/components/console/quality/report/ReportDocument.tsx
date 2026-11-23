import { BadgerMark } from "@ratel/design-system/badger-mark";
import {
  formatMs,
  LatencyBars,
  RankLegend,
  RankMixChart,
  RateComparison,
  TrendChart,
} from "@/components/console/quality/report/charts";
import { fmtCompact, fmtInt, fmtPct } from "@/components/console/quality/report/format";
import { ArmLegend, QualityScope } from "@/components/console/quality/report/panels";
import { armColor } from "@/components/console/quality/report/theme";
import { pickHeadline } from "@/lib/synthesis/quality/headline";
import { explainQualityGap, type QualityScore } from "@/lib/synthesis/quality/metrics";
import { armSpeedup, type QualityView } from "@/lib/synthesis/quality/service";
import type { CatalogFingerprintChange, QualityTrendRow } from "@/lib/synthesis/quality/snapshot";
import {
  projectMonthly,
  SAVINGS_BASELINE,
  SAVINGS_BASELINE_NOTE,
} from "@/lib/synthesis/quality/tokens";
import { headlineTrend, trendMarkers } from "@/lib/synthesis/quality/trend-view";

/**
 * The partner report: three pages, results only.
 *
 * This is the artifact a design partner actually reads, so it carries findings
 * and nothing else. How a number is computed, what we assume, where telemetry is
 * thin, and what we deliberately do not claim all live in the admin console
 * instead. A partner who wants the method asks, and then they get a person
 * rather than pages of small print they were never going to read.
 *
 * Dropping the method is not the same as dropping the honesty: every figure
 * still carries its denominator, and nothing counterfactual is stated as banked.
 */

export interface ReportData {
  view: QualityView;
  trend: QualityTrendRow[];
  fingerprintChanges: CatalogFingerprintChange[];
  /** When this project was first fingerprinted; see `trendMarkers`. */
  firstFingerprintAt: Date | null;
  generatedAt: Date;
  windowDays: number;
}

export function ReportDocument({
  view,
  trend,
  fingerprintChanges,
  firstFingerprintAt,
  generatedAt,
  windowDays,
}: ReportData) {
  const revealed = view.tiers.find((tier) => tier.tier === "revealed")!;
  const baselineArm = revealed.baselineArm;
  const subjectArm = view.arms.find((arm) => arm !== baselineArm) ?? view.arms[0];

  // Same rule as the console: every quality figure is scored against a known
  // answer, the answer key first and the tool the agent ran otherwise. With
  // neither, the report says there is no accuracy yet rather than comparing
  // the two lists, which would assume one of them was right.
  const headline = pickHeadline(view.tiers, subjectArm);
  const resultsTier = headline?.tier ?? null;
  const subject = headline?.subject;
  const baseline = headline?.baseline ?? null;
  const fromAnswerKey = headline?.tier.tier === "judged";
  const savings = subjectArm ? view.savings.get(subjectArm) : undefined;
  const monthly = savings ? projectMonthly(savings, windowDays) : null;
  const speedup = subjectArm ? armSpeedup(view.latency, baselineArm, subjectArm) : null;
  const subjectLatency = subjectArm ? view.latency.get(subjectArm) : undefined;
  const baselineLatency = baselineArm ? view.latency.get(baselineArm) : undefined;

  // Only days scored against an answer are drawn; see `headlineTrend`.
  const series = headlineTrend(trend).series.map((entry) => ({
    arm: entry.arm,
    color: armColor(entry.arm, baselineArm),
    points: entry.points,
  }));
  const markers = trendMarkers(fingerprintChanges, view.window, firstFingerprintAt);

  const dateLabel = generatedAt.toLocaleDateString("en-IE", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const partner = view.organizationName ?? view.projectName;
  const us = subjectArm ?? "Ratel";
  const them = baselineArm ?? "your search";
  const armLabel = (arm: string) => (arm === baselineArm ? `${arm} (yours)` : arm);

  return (
    <QualityScope surface="print" className="report">
      {/* ----------------------------------------------------------- cover */}
      <section className="report-page report-cover">
        <div className="cover-top">
          <BadgerMark className="mark" />
          <p className="kicker" style={{ margin: 0 }}>
            Shadow report &middot; {dateLabel}
          </p>
        </div>

        <div className="cover-mid">
          <p className="kicker">{partner}</p>
          <h1>
            {us} answered {fmtInt(view.diagnostics.comparisonCount)} of your searches, alongside{" "}
            {them}.
          </h1>
          <p className="cover-lede">
            {headline ? (
              <>
                Nothing was served from {us}. It ran the same query at the same moment, and we
                checked both lists against the right tool for each request.
              </>
            ) : (
              <>
                Both searches ran on every one of them, at the same moment, on the same catalog.
                This report compares what each returned.
              </>
            )}
          </p>
        </div>

        <div className="hero-row">
          <Hero
            value={
              speedup === null
                ? formatMs(subjectLatency?.p50Ms ?? null)
                : `${speedup.toFixed(speedup >= 10 ? 0 : 1)}×`
            }
            accent
            label={
              <>
                faster to answer
                <br />
                {formatMs(subjectLatency?.p50Ms ?? null)} against{" "}
                {formatMs(baselineLatency?.p50Ms ?? null)}
              </>
            }
          />
          {/* The comparison is the whole catalog, never the other arm. A cover
              that says "95% less prompt" beside a legacy-vs-ratel latency chart
              invites exactly the wrong reading, so the baseline is named in the
              label rather than left to the page-three card. */}
          <Hero
            value={savings ? fmtPct(savings.savedShare) : "—"}
            accent
            label={
              <>
                less prompt than sending {SAVINGS_BASELINE}
                <br />
                {savings
                  ? `${fmtCompact(savings.savedPerSearch)} tokens not sent, every search`
                  : ""}
              </>
            }
          />
          {/* Containment is the cover figure: the agent reads the whole list,
              so reaching the right tool inside it IS the job. Scored only over
              requests with a known answer, and the denominator rides in the
              label. With no answer yet there is no third figure at all. */}
          {headline && subject && (
            <Hero
              value={subject.score.containment == null ? "—" : fmtPct(subject.score.containment)}
              label={
                <>
                  of the time we had the right tool
                  <br />
                  over {fmtInt(subject.score.n)}{" "}
                  {fromAnswerKey
                    ? "requests with a decided answer"
                    : "searches your agent acted on"}
                </>
              }
            />
          )}
        </div>

        <div className="cover-foot">
          <span>
            {view.projectName} &middot; {windowDays} days to{" "}
            {view.window.until.toISOString().slice(0, 10)}
          </span>
          <span>Prepared by Ratel</span>
        </div>
      </section>

      {/* --------------------------------------------------------- quality */}
      <section className="report-page">
        <p className="kicker">Quality</p>
        <h2>Did we put the right tool in front of your agent?</h2>

        {resultsTier ? (
          <>
            <p className="small">
              {fromAnswerKey ? (
                <>
                  Accuracy against an answer key: the right tool for each request, decided by a
                  model once per distinct request, or the tool your agent ran for it. Requests it
                  could not decide are left out, never guessed. {fmtInt(view.answers.answered)} of{" "}
                  {fmtInt(view.answers.searches)} searches in this period have an answer, and every
                  figure here is over those.
                </>
              ) : (
                <>
                  Every time your agent ran a tool, we checked whether that tool was in each list.
                </>
              )}
            </p>
            <RateComparison
              width={690}
              rows={resultsTier.arms.map((arm) => ({
                label: armLabel(arm.arm),
                value: arm.score.containment,
                interval: arm.score.containmentInterval,
                color: armColor(arm.arm, baselineArm),
                meta: `${fmtInt(arm.score.n)} searches`,
              }))}
            />
            <p className="small" style={{ marginTop: 14 }}>
              And how high it came in that list.
            </p>
            <RankLegend />
            <RankMixChart
              width={690}
              rows={resultsTier.arms
                .filter((arm) => arm.score.n > 0)
                .map((arm) => ({
                  label: armLabel(arm.arm),
                  histogram: arm.score.rankHistogram,
                  total: arm.score.n,
                }))}
            />
          </>
        ) : (
          <p className="small">
            No request in this period has a decided answer yet, so there is no accuracy to report.
            We do not score one list against the other, because that would assume one of them was
            right.
          </p>
        )}

        {subject && baseline && (
          <div
            className={
              (subject.score.quality ?? 0) >= (baseline.score.quality ?? 0)
                ? "card ok"
                : "card warn"
            }
            style={{ marginTop: 16 }}
          >
            <h3>What this means</h3>
            <p>{verdict(subject, baseline, us, them)}</p>
          </div>
        )}

        {series.length > 0 && (
          <>
            <h3 style={{ marginTop: 16 }}>Across the {windowDays} days</h3>
            <ArmLegend arms={view.arms} baselineArm={baselineArm} baselineNote="yours" />
            <TrendChart series={series} markers={markers} width={690} height={132} />
          </>
        )}
      </section>

      {/* --------------------------------------------------- speed and cost */}
      <section className="report-page">
        <p className="kicker">Speed and cost</p>
        <h2>What retrieval is worth to you</h2>

        <div className="hero-row" style={{ marginTop: 6 }}>
          <Hero
            value={speedup === null ? "—" : `${speedup.toFixed(speedup >= 10 ? 0 : 1)}×`}
            accent
            label={`faster than ${them}, at the median`}
          />
          {savings && monthly && (
            <>
              <Hero
                value={fmtCompact(monthly.tokensPerMonth)}
                accent
                label={`prompt tokens a month you would stop sending, against ${SAVINGS_BASELINE}, at this volume`}
              />
              <Hero
                value={`$${
                  monthly.usdPerMonth < 10
                    ? monthly.usdPerMonth.toFixed(2)
                    : fmtCompact(Math.round(monthly.usdPerMonth))
                }`}
                accent
                label={`a month against ${SAVINGS_BASELINE}, at $${savings.pricePerMtok} per million input tokens`}
              />
            </>
          )}
        </div>

        <p className="small">
          <strong>Time to answer.</strong> Median across every search, both arms drawn to one scale.
        </p>
        <LatencyBars
          rows={view.arms.map((arm) => ({
            arm: armLabel(arm),
            ms: view.latency.get(arm)?.p50Ms ?? null,
            color: armColor(arm, baselineArm),
          }))}
        />

        {savings && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3>What the saving is measured against</h3>
            <p>
              Against {SAVINGS_BASELINE}, not against {them}. Your catalog is{" "}
              {fmtInt(view.inventory.entryCount)} tools, and handing all of them to a model costs
              about <strong>{fmtCompact(savings.fullCatalogTokens)} tokens</strong> of prompt on
              every turn. With {us} retrieving, your agent carries about{" "}
              {fmtCompact(savings.servedTokens)} instead
              {monthly && (
                <>
                  , and at {Math.round(monthly.searchesPerDay)} searches a day that is{" "}
                  {fmtCompact(monthly.tokensPerMonth)} tokens a month
                </>
              )}
              .
            </p>
          </div>
        )}

        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Arm</th>
              <th>Median</th>
              <th>95th percentile</th>
              <th>Results returned</th>
              <th>Searches</th>
            </tr>
          </thead>
          <tbody>
            {view.arms.map((arm) => {
              const stats = view.latency.get(arm);
              const cost = view.listCost.get(arm);
              return (
                <tr key={arm}>
                  <td>{armLabel(arm)}</td>
                  <td>{formatMs(stats?.p50Ms ?? null)}</td>
                  <td>{formatMs(stats?.p95Ms ?? null)}</td>
                  <td>{cost?.averageReturned?.toFixed(1) ?? "—"}</td>
                  <td>{fmtInt(stats?.samples ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="foot">
          {view.projectName} &middot; {fmtInt(view.diagnostics.comparisonCount)} shadow-tested
          searches between {view.window.since.toISOString().slice(0, 10)} and{" "}
          {view.window.until.toISOString().slice(0, 10)}
          {/* Saying "N searches" over a scored sample of fewer would be the one
              kind of inaccuracy this report cannot afford, so a capped window
              says which figure is the sample. */}
          {view.diagnostics.truncated && (
            <>, of which the most recent {fmtInt(view.diagnostics.selectionCount)} were scored</>
          )}
          .
          {savings && (
            <>
              {" "}
              {SAVINGS_BASELINE_NOTE} Token figures are estimated from your catalog text and priced
              at ${savings.pricePerMtok} per million input tokens.
            </>
          )}
        </p>
      </section>
    </QualityScope>
  );
}

function Hero({
  value,
  label,
  accent = false,
}: {
  value: string;
  label: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="hero">
      <div className={accent ? "n accent" : "n"}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

/**
 * The one paragraph a reader who skims everything else will read.
 *
 * Written from the decomposition rather than a threshold, so it cannot name the
 * wrong cause: quality is containment times placement, which splits any gap into
 * a coverage term and a ranking term that sum to it exactly.
 */
function verdict(
  subject: { arm: string; score: QualityScore },
  baseline: { arm: string; score: QualityScore },
  us: string,
  them: string,
): string {
  const gap = explainQualityGap(subject.score, baseline.score);
  const n = fmtInt(subject.score.n);
  if (!gap) {
    return `There is not yet enough evidence in this window to compare ${us} against ${them}.`;
  }
  if (Math.abs(gap.total) < 0.02) {
    return `Across ${n} searches the two lists land within two points of each other. They are doing the same job, and ${us} is doing it in a fraction of the time.`;
  }
  if (gap.total > 0) {
    return `Across ${n} searches ${us} placed the right tool better than ${them} by ${fmtPct(gap.total)}, and did it in a fraction of the time.`;
  }
  if (gap.driver === "placement") {
    return `Across ${n} searches ${us} finds the right tool about as often as ${them} but ranks it lower: ${fmtPct(-gap.placement)} of the ${fmtPct(-gap.total)} difference is position in the list, and only ${fmtPct(-gap.containment)} is not returning it at all. Ordering is ours to fix, and that work is in flight.`;
  }
  if (gap.driver === "containment") {
    return `Across ${n} searches ${us} trails ${them} by ${fmtPct(-gap.total)}, almost all of it because the tool was missing from the list rather than ranked low. When it is returned, it is ranked about as well. That points at how tools describe themselves rather than at the ordering.`;
  }
  return `Across ${n} searches ${us} trails ${them} by ${fmtPct(-gap.total)}, split between ${fmtPct(-gap.containment)} from not returning the tool and ${fmtPct(-gap.placement)} from where it was ranked.`;
}
