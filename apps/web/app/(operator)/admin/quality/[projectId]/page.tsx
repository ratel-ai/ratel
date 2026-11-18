import Link from "next/link";
import type { ReactNode } from "react";
import "@/components/console/quality/report/quality.css";
import { Disclosure, Fact } from "@/components/console/quality/admin/Disclosure";
import { Card, PageHeader, Section } from "@/components/console/quality/admin/primitives";
import { SegmentedControl } from "@/components/console/quality/admin/SegmentedControl";
import { TrendChart } from "@/components/console/quality/report/charts";
import { fmtCompact, fmtInt, fmtPct } from "@/components/console/quality/report/format";
import {
  ArmLegend,
  CatalogInventoryPanel,
  CoveragePanel,
  FollowThroughPanel,
  LatencyPanel,
  ListCostPanel,
  QualityScope,
  RankPanel,
  SavingsPanel,
  TierPanel,
  UnifiedPanel,
} from "@/components/console/quality/report/panels";
import { armColor } from "@/components/console/quality/report/theme";
import { pickHeadline, topOneShare } from "@/lib/synthesis/quality/headline";
import { armSpeedup } from "@/lib/synthesis/quality/service";
import {
  CHARS_PER_TOKEN,
  SAVINGS_BASELINE,
  SAVINGS_BASELINE_NOTE,
} from "@/lib/synthesis/quality/tokens";
import { headlineTrend, trendMarkers } from "@/lib/synthesis/quality/trend-view";
import {
  loadOperatorQualityDetail,
  QUALITY_WINDOW_OPTIONS as WINDOW_OPTIONS,
} from "@/lib/views/quality/operator-pages";

export const dynamic = "force-dynamic";

/**
 * One calibration's quality, in full.
 *
 * The page is ordered the way the question is actually asked: how good are we,
 * how sure are we, where do we lose it, and what does the partner get in return.
 * Every rate carries its `n`, and every accuracy is against a KNOWN answer: the
 * answer key (decided by the decision model once per distinct request) or the tool the agent
 * ran. A search with neither is left out and counted as such, never guessed,
 * and never scored against the incumbent's own list.
 *
 * Owned (ADR-0030): the core draws it inside the edition's operator console
 * (`EditionUi.OperatorConsole`), whose `authorize` runs before any read in place of
 * upstream's platform-admin gate; without the console it is a 404. The reads are
 * upstream's, made by `loadOperatorQualityDetail`. The quality stylesheet, which
 * upstream loads globally, is loaded here.
 */
export default async function AdminQualityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ days?: string; calibration?: string }>;
}) {
  const [{ projectId: requestedProjectId }, search] = await Promise.all([params, searchParams]);
  const page = await loadOperatorQualityDetail(requestedProjectId, search);
  const { Frame } = page;

  if (page.state === "no-database") {
    return (
      <Frame>
        <PageHeader title="Quality" />
        <Card>
          <p className="text-sm text-warm-muted">No database connected.</p>
        </Card>
      </Frame>
    );
  }

  if (page.state === "no-calibration") {
    return (
      <Frame>
        <PageHeader title="Quality" />
        <Card>
          <p className="text-sm text-warm-muted">
            This project has no shadow comparisons in the last {page.windowDays} days.
          </p>
        </Card>
      </Frame>
    );
  }

  const {
    projectId,
    experimentName,
    window,
    windowDays,
    calibrations,
    view,
    trend,
    fingerprintChanges,
    firstFingerprintAt,
    windowCounts,
  } = page;

  // Computed once: the corpus panel counts the same rules the chart draws, so
  // reading a "2 changes" beside a chart with one line would be a real
  // discrepancy rather than a rounding one.
  const markers = trendMarkers(fingerprintChanges, window, firstFingerprintAt);

  const revealed = view.tiers.find((tier) => tier.tier === "revealed")!;
  const judged = view.tiers.find((tier) => tier.tier === "judged")!;
  const baselineArm = revealed.baselineArm;
  // The arm the report is about: whichever one is not the incumbent.
  const subjectArm = view.arms.find((arm) => arm !== baselineArm) ?? view.arms[0];
  // Accuracy against a known answer, the answer key first. Null when no search
  // in the window has one, and then the page says that instead of a number.
  const headline = pickHeadline(view.tiers, subjectArm);
  const savings = subjectArm ? view.savings.get(subjectArm) : undefined;
  const speedup = subjectArm ? armSpeedup(view.latency, baselineArm, subjectArm) : null;
  const gap = headline?.gap ?? null;
  const baselineScore = headline?.baseline ?? null;
  const them = baselineArm ?? "the baseline";

  // Days rolled up before the answer key existed were scored against the
  // incumbent's own list and are stored as `reference`; they are not drawn.
  const trendView = headlineTrend(trend);
  const series = trendView.series.map((entry) => ({
    arm: entry.arm,
    color: armColor(entry.arm, baselineArm),
    points: entry.points,
  }));

  const href = (next: { days?: number; calibration?: string }) =>
    `/admin/quality/${projectId}?calibration=${encodeURIComponent(
      next.calibration ?? experimentName,
    )}&days=${next.days ?? windowDays}`;

  // A longer window that returns the same rows is not a longer window. Saying
  // so is the difference between "this control is broken" and "this project
  // has not been sending telemetry that long", which is the actual reason.
  // Measured against the window's own upper bound rather than the clock: the
  // render must be a pure function of what it was handed.
  const daysAvailable = windowCounts.earliest
    ? Math.ceil((window.until.getTime() - windowCounts.earliest.getTime()) / (24 * 60 * 60 * 1000))
    : null;
  const windowExceedsData = daysAvailable !== null && windowDays > daysAvailable + 1;

  return (
    <Frame>
      <QualityScope surface="screen">
        <PageHeader
          title={`Quality · ${view.projectName}`}
          subtitle={
            <>
              {view.organizationName ? `${view.organizationName} · ` : ""}
              {experimentName}
            </>
          }
        />

        <div className="mb-5 flex flex-wrap items-end gap-4">
          {calibrations.length > 1 && (
            <div className="min-w-[220px]">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-warm-muted">
                Calibration
              </div>
              <SegmentedControl
                ariaLabel="Calibration"
                activeIndex={calibrations.findIndex(
                  (entry) => entry.experimentName === experimentName,
                )}
                segments={calibrations.map((entry) => ({
                  label: entry.experimentName,
                  href: href({ calibration: entry.experimentName }),
                  meta: `${fmtInt(entry.comparisonCount)}`,
                }))}
              />
            </div>
          )}
          <div className="min-w-[280px]">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-warm-muted">
              Window
            </div>
            {/* The count under each option is the point: the rates barely move
              between windows because the metric is stable, so without the
              sample size the control looks inert. */}
            <SegmentedControl
              ariaLabel="Time window"
              activeIndex={WINDOW_OPTIONS.indexOf(windowDays)}
              segments={WINDOW_OPTIONS.map((option) => ({
                label: `${option}d`,
                href: href({ days: option }),
                meta: `${fmtInt(windowCounts.counts.get(option) ?? 0)}`,
              }))}
            />
          </div>
          <Link
            href={`/report/quality/${projectId}?calibration=${encodeURIComponent(experimentName)}&days=${windowDays}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-xs text-coral hover:bg-coral/20"
          >
            Partner report (PDF)
          </Link>
        </div>

        {windowExceedsData && (
          <p className="q-banner mb-5">
            Telemetry only goes back {daysAvailable} days here, so a {windowDays}-day window and a{" "}
            {daysAvailable}-day one hold the same searches. That is how long this project has been
            sending telemetry, not a limit on this page.
          </p>
        )}

        {/* ------------------------------------------------- the answer band */}
        {subjectArm && (
          <Section title="The answer">
            <div className="q-summary">
              {headline && (
                <>
                  <SummaryCell
                    label="Right tool first"
                    accent
                    value={fmtShare(topOneShare(headline.subject.score))}
                    sub={
                      <>
                        Top-1 accuracy: the answer led our list, over{" "}
                        {fmtInt(headline.subject.score.n)} searches.
                        {baselineScore && (
                          <>
                            {" "}
                            {baselineScore.arm}: {fmtShare(topOneShare(baselineScore.score))} on the
                            same searches.
                          </>
                        )}
                      </>
                    }
                  />
                  <SummaryCell
                    label="Containment"
                    value={fmtShare(headline.subject.score.containment)}
                    sub={
                      <>
                        The answer anywhere in the list, rank ignored.
                        {baselineScore && (
                          <>
                            {" "}
                            {baselineScore.arm}: {fmtShare(baselineScore.score.containment)}.
                          </>
                        )}
                      </>
                    }
                  />
                </>
              )}
              <SummaryCell
                label="Speed"
                accent
                value={speedup === null ? "—" : `${speedup.toFixed(speedup >= 10 ? 0 : 1)}×`}
                sub={`Faster than ${them} at the median.`}
              />
              <SummaryCell
                label={
                  savings?.realized
                    ? `Prompt saved vs ${SAVINGS_BASELINE}`
                    : `Prompt avoidable vs ${SAVINGS_BASELINE}`
                }
                value={savings ? fmtPct(savings.savedShare) : "—"}
                sub={
                  savings
                    ? `${fmtCompact(savings.savedPerSearch)} tokens a search against carrying all ${fmtInt(view.inventory.entryCount)} tools in the prompt. Not a comparison with ${them}.`
                    : ""
                }
              />
            </div>
            {headline ? (
              <p className="q-note mt-3">
                Scored against{" "}
                {headline.tier.tier === "judged" ? "the answer key" : "the tool the agent ran"},
                over {fmtInt(headline.subject.score.n)} searches.{" "}
                <span className="tabular-nums text-cream">{fmtInt(view.answers.answered)}</span> of{" "}
                {fmtInt(view.answers.searches)} searches in this window have a known answer.{" "}
                <span className="tabular-nums text-cream">{fmtInt(view.answers.unclear)}</span> were
                read and left unclear, and are left out.{" "}
                <span className="tabular-nums text-cream">{fmtInt(view.answers.unread)}</span> have
                not been read yet; the weekly pass reads more. Accuracy is only ever over searches
                with an answer, never guessed.
                {headline.tier.tier === "revealed" &&
                  " The answer key has no verdict for this window yet, so this is the tool the agent ran."}
              </p>
            ) : (
              <p className="q-note mt-3">
                No search in this window has an answer yet. The answer key is filled weekly by the
                match-quality pass for projects with match quality on.
              </p>
            )}
            {gap && baselineScore && Math.abs(gap.total) >= 0.02 && (
              <p className="q-note mt-3">
                {gap.total > 0 ? "Ahead of" : "Behind"} {baselineScore.arm} by{" "}
                <span className="tabular-nums text-cream">{fmtPct(Math.abs(gap.total))}</span> on
                rank-credited quality ({fmtShare(headline!.subject.score.quality)} against{" "}
                {fmtShare(baselineScore.score.quality)}). Of that,{" "}
                <span className="tabular-nums text-cream">{fmtPct(Math.abs(gap.placement))}</span>{" "}
                is where the tool was ranked and{" "}
                <span className="tabular-nums text-cream">{fmtPct(Math.abs(gap.containment))}</span>{" "}
                is not returning it at all
                {gap.driver === "placement" && ", so this is a ranking problem"}
                {gap.driver === "containment" && ", so this is a coverage problem"}.
              </p>
            )}
          </Section>
        )}

        <Section title="Both arms, both kinds of answer">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-sm font-medium text-cream">
                Answer key: decided by a model
              </h3>
              <TierPanel tier={judged} />
            </Card>
            <Card>
              <h3 className="mb-2 text-sm font-medium text-cream">Revealed: what the agent ran</h3>
              <TierPanel tier={revealed} />
            </Card>
          </div>
        </Section>

        <Section title="Quality, on the best answer each search has">
          <Card>
            <UnifiedPanel unified={view.unified} arms={view.arms} baselineArm={baselineArm} />
            <Disclosure summary="How one score comes out of two kinds of answer">
              <p>
                Telemetry arrives unevenly. Some searches are linked to the tool the agent then ran;
                most are not, and for those the answer key is the answer. The choice is made per
                search.
              </p>
              <Fact label="When the tool is known">
                Half a point for the tool being anywhere in the arm&rsquo;s list, which is the list
                the agent saw, and the other half scaled by <code>1 / log2(1 + rank)</code>. Rank 1
                earns 1.00, rank 2 0.82, rank 3 0.75. Zero when the arm never returned it.
              </Fact>
              <Fact label="When it is not">
                The same credit, against the answer key&rsquo;s tool for the request: a decision
                model read the request against what each tool is and named the right one, once per
                distinct query. Every arm, {them} included, is scored against it.
              </Fact>
              <Fact label="When neither exists">
                The search is left out. There is no fallback to {them}&rsquo;s own list: that
                assumed {them} was right, and scored it as always right.
              </Fact>
              <Fact label="Why the split is always shown">
                The two are on the same [0, 1] scale but come from different places. If a partner
                starts attributing more of their invocations, the blend can move without retrieval
                having changed. Compare two windows only when their splits are close.
              </Fact>
              <Fact label="Serving arms">
                An agent can only run what it was shown, so an arm scored on its own served list has
                a containment near 100% by construction. Those searches still count toward the
                score, because how far down its own list the agent had to go is real, but they are
                excluded from the containment figure.
              </Fact>
            </Disclosure>
          </Card>
        </Section>

        <Section title="Did the agent act on what it was given">
          <Card>
            <FollowThroughPanel followThrough={view.followThrough} baselineArm={baselineArm} />
            <Disclosure summary="Why this sits beside the quality figures">
              <p>
                An agent can only run a tool it was shown, so the tool it ran is in the serving
                arm&rsquo;s list by construction. Scoring that arm against it would restate the
                setup and hand whoever is serving a free 100%, so revealed evidence is only ever
                produced for the arm that did NOT serve.
              </p>
              <Fact label="The bias that leaves">
                We can still only score searches the agent acted on. If a served list is poor and
                the agent gives up, that search leaves the population instead of counting against
                the arm that served it.
              </Fact>
              <Fact label="What this measures">
                Exactly those dropped searches. It is not folded into quality, because many searches
                end without a call for reasons retrieval has no part in, but a large gap between
                arms here is real evidence that scoring cannot see.
              </Fact>
            </Disclosure>
          </Card>
        </Section>

        {/* Rank position only means something when we know which tool was the
          answer, so it is drawn from the headline's tier and nowhere else. */}
        {headline && (
          <Section title="Where the answer landed">
            <Card>
              <ArmLegend arms={view.arms} baselineArm={baselineArm} />
              <RankPanel tier={headline.tier} />
              <Disclosure summary="How each band is worked out">
                <p>
                  One search contributes to exactly one band, so the four always sum to 100% of that
                  arm&rsquo;s evaluable searches.
                </p>
                <Fact label="The target">
                  {headline.tier.tier === "judged"
                    ? "The answer key's tool for the request, decided by a decision model once per distinct query or taken from what the agent ran for it. It is chosen without looking at either arm's list."
                    : "The tool your agent actually invoked after the search. The agent's own behaviour decides what the answer was."}
                </Fact>
                <Fact label="The position">
                  We take the arm&rsquo;s recorded result list for that same search and find the
                  target&rsquo;s index in it. Index 1 is <em>we led with it</em>, indexes 2 and 3
                  are <em>2nd or 3rd</em>, anything deeper is <em>4th or lower</em>.
                </Fact>
                <Fact label="Not in the list">
                  The arm returned results, and the target was not among them. This is a scored
                  miss, not missing data.
                </Fact>
                <Fact label="When there is no answer">
                  A search with no known answer, or one the key marked unclear, is dropped from the
                  population rather than counted as a failure or guessed. That is why <code>n</code>{" "}
                  is smaller than the comparison count, and why it is printed beside every figure.
                </Fact>
              </Disclosure>
            </Card>
          </Section>
        )}

        {series.length > 0 && (
          <Section title="Quality over time">
            <Card>
              <ArmLegend arms={view.arms} baselineArm={baselineArm} />
              <TrendChart series={series} markers={markers} />
              <p className="q-note">
                {trendView.tier === "judged"
                  ? "Scored against the answer key. The line starts from the first daily rollup after the key existed; older days were scored against the incumbent's own list and are not drawn."
                  : "Scored against the tool the agent ran: the answer key has no plotted day in this window yet."}{" "}
                Dashed rules mark a change to what retrieval matches on. Days with fewer than five
                evaluable searches are left as gaps rather than plotted, so a quiet afternoon cannot
                read as a spike.
              </p>
            </Card>
          </Section>
        )}

        <Section title="What the partner gets, and what it costs them">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-sm font-medium text-cream">Speed</h3>
              <LatencyPanel
                latency={view.latency}
                arms={view.arms}
                baselineArm={baselineArm}
                speedup={speedup}
              />
            </Card>
            <Card>
              <h3 className="mb-2 text-sm font-medium text-cream">Cost of the list</h3>
              <ListCostPanel listCost={view.listCost} arms={view.arms} baselineArm={baselineArm} />
            </Card>
            {savings && subjectArm && (
              <Card>
                <h3 className="mb-2 text-sm font-medium text-cream">Tokens and money</h3>
                <SavingsPanel savings={savings} arm={subjectArm} windowDays={windowDays} />
              </Card>
            )}
            <Card>
              <h3 className="mb-2 text-sm font-medium text-cream">
                The corpus behind these numbers
              </h3>
              <CatalogInventoryPanel
                inventory={view.inventory}
                fingerprintChanges={markers.length}
              />
            </Card>
          </div>
        </Section>

        {/* List overlap, kept as a diagnostic. It used to stand in for accuracy
          when no answer was known; it never does now, so it sits down here. */}
        <Section title={`Diagnostic: list overlap with ${them}`}>
          <Card>
            <CoveragePanel coverage={view.coverage} arms={view.arms} baselineArm={baselineArm} />
            <p className="q-note mt-2">
              List overlap, not accuracy. Neither list is assumed to be right; the figures above are
              the ones scored against an answer.
            </p>
            <Disclosure summary="Why this is not just their first result">
              <p>
                Their first result is not necessarily the right answer either. If the answer was
                actually their third and we returned their second and third, we did fine, and
                scoring only their top result would call that a total miss.
              </p>
              <Fact label="The target">
                Their whole ranked list for the same search, not one item from it.
              </Fact>
              <Fact label="The score">
                The share of that list we also returned, with each of their positions weighted by{" "}
                <code>1 / log2(1 + rank)</code>. Their ordering is evidence even though it is not
                truth, so missing their first costs more than missing their fourth.
              </Fact>
              <Fact label="What it is not">
                Accuracy. It is recall against a system the customer already trusts. If they are
                wrong, matching them is wrong too, which is why this never appears as a quality
                score on its own.
              </Fact>
            </Disclosure>
          </Card>
        </Section>

        <Section title="What we have, and what we assume">
          <Card>
            <dl className="m-0">
              <div className="q-stat-row">
                <dt>Shadow comparisons read</dt>
                <dd>
                  {fmtInt(view.diagnostics.selectionCount)}
                  {view.diagnostics.truncated && " (capped)"}
                </dd>
              </div>
              <div className="q-stat-row">
                <dt>With a ranked list from at least one arm</dt>
                <dd>
                  {fmtInt(view.diagnostics.rankedSelectionCount)}
                  {view.diagnostics.selectionCount > 0 && (
                    <>
                      {" "}
                      ·{" "}
                      {fmtPct(
                        view.diagnostics.rankedSelectionCount / view.diagnostics.selectionCount,
                      )}
                    </>
                  )}
                </dd>
              </div>
              <div className="q-stat-row">
                <dt>With an attributed invocation (revealed evidence)</dt>
                <dd>
                  {fmtInt(view.diagnostics.invocationCount)}
                  {view.diagnostics.selectionCount > 0 && (
                    <>
                      {" "}
                      · {fmtPct(view.diagnostics.invocationCount / view.diagnostics.selectionCount)}
                    </>
                  )}
                </dd>
              </div>
              <div className="q-stat-row">
                <dt>With a known answer (agent&rsquo;s tool or answer key)</dt>
                <dd>
                  {fmtInt(view.answers.answered)}
                  {view.answers.searches > 0 && (
                    <> · {fmtPct(view.answers.answered / view.answers.searches)}</>
                  )}
                </dd>
              </div>
              <div className="q-stat-row">
                <dt>Read by the answer key and left unclear</dt>
                <dd>{fmtInt(view.answers.unclear)}</dd>
              </div>
              <div className="q-stat-row">
                <dt>Not read by the answer key yet</dt>
                <dd>{fmtInt(view.answers.unread)}</dd>
              </div>
              <div className="q-stat-row">
                <dt>Invoked tool read from</dt>
                <dd className="font-mono text-[11px]">
                  {view.diagnostics.invokedToolKey ?? "not found"}
                </dd>
              </div>
            </dl>
            {view.diagnostics.invokedToolKey === null && view.diagnostics.selectionCount > 0 && (
              <p className="q-note mt-2">
                No invocation record in this window carried a tool id under any known key, so the
                revealed tier falls back to the rank the SDK recorded. That is a telemetry gap, not
                a quality result.
              </p>
            )}

            <Disclosure summary="Where these numbers come from">
              <Fact label="The source">
                Three record types the SDK exports, joined on one selection id: a comparison per
                shadow-tested search, a result list per arm, and an invocation when the agent went
                on to run something.
              </Fact>
              <Fact label="The answer key">
                The one place a model is involved. The decision model (OpenAI, Jev or Sage) reads
                each distinct request (normalized query) once against what each tool is and names
                the right one, or marks it unclear; an observed invocation for the same request
                counts too. Stored in <code>match_quality_labels</code> and filled weekly by the
                match-quality pass. Unclear and unread searches are excluded from every accuracy
                figure.
              </Fact>
              <Fact label="Attribution">
                This window is running on <code>{view.diagnostics.attributionMode}</code>.{" "}
                {revealed.note}
              </Fact>
              <Fact label="Searches we cannot score">
                {fmtInt(
                  Math.max(
                    0,
                    view.diagnostics.selectionCount - view.diagnostics.rankedSelectionCount,
                  ),
                )}{" "}
                of {fmtInt(view.diagnostics.selectionCount)} carry no ranked list from either arm,
                so no position can be read from them.
              </Fact>
            </Disclosure>

            <Disclosure summary="Assumptions in the money and token figures">
              <Fact label="What the saving is measured against">
                {SAVINGS_BASELINE_NOTE} The alternative to retrieval is handing the model every
                tool, so that is the baseline; {baselineArm ?? "the incumbent"} is a search engine
                rather than a prompt budget, and comparing token cost against it would not mean
                anything.
              </Fact>
              <Fact label="Token estimate">
                Catalog text at {CHARS_PER_TOKEN} characters per token, counting each tool&rsquo;s
                name, agent description and input schema. Both arms are estimated the same way, so
                the comparison holds even where the absolute figure drifts. No tokenizer is
                involved.
              </Fact>
              <Fact label="Per-search cost">
                The whole-catalog cost scaled by the share of the catalog an arm returned, rather
                than summing the exact definitions of every returned id. The approximation lands
                within a few percent and its error is far smaller than the characters-per-token
                assumption above.
              </Fact>
              <Fact label="Monthly figures">
                A projection, not a measurement: the window&rsquo;s search rate multiplied out to 30
                days. It assumes this window is representative.
              </Fact>
              <Fact label="What we cannot see">
                Whether a tool the agent ran was genuinely the best answer, only that it is the one
                chosen. Searches the agent abandoned. And, while an arm only shadows, whether any of
                the saving would survive it actually serving.
              </Fact>
            </Disclosure>
          </Card>
        </Section>
      </QualityScope>
    </Frame>
  );
}

/** One figure in the answer band. */
function SummaryCell({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="q-summary-cell">
      <div className="q-summary-label">{label}</div>
      <div className={accent ? "q-summary-value accent" : "q-summary-value"}>{value}</div>
      <div className="q-summary-sub">{sub}</div>
    </div>
  );
}

/** A share, or a dash when there is nothing to divide by. */
function fmtShare(value: number | null): string {
  return value === null ? "—" : fmtPct(value);
}
