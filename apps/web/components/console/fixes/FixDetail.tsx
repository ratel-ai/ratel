import { StatusDot } from "@ratel/design-system/badge";
import { CodeBlock, CopyButton } from "@ratel/design-system/code";
import { Disclosure } from "@ratel/design-system/disclosure";
import { NounIcon } from "@ratel/design-system/entity";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import type { CraftDetail, Fix, IssueDetail, RewriteDetail } from "@/lib/views/fixes/types";
import { EFFECT_ICONS } from "./effect-icons";
import { AffectsLinks } from "./FixAffects";
import { EffectArrow, EvidenceValue } from "./FixCells";
import { KIND_MOTION_STYLES, KindMotion } from "./KindMotion";
import { FIX_KIND_ICONS } from "./kind-icons";

/**
 * One fix in the Panel, visual first: the kind's mark and the effect as a big
 * figure with its evidence, the actions, what it touches as pins, a rewrite's
 * before and after, the issues it resolves as compact rows, then the change.
 * The derivations and the drafted change's facts wait behind "Details".
 */
export function FixDetail({ fix, actions }: { fix: Fix; actions: ReactNode }) {
  const detail = fix.detail;
  return (
    <div
      className="flex flex-col gap-6"
      data-fix-detail={fix.id}
      data-fix-source={fix.source}
      data-fix-group={fix.group}
    >
      <Hero fix={fix} actions={actions} />
      <AffectsLinks subject={fix.subject} />
      {detail.source === "rewrite" ? (
        <BeforeAfter detail={detail} applied={fix.status === "applied"} />
      ) : null}
      <IssuesSection fix={fix} />
      {detail.source === "craft" ? <CraftChange fix={fix} detail={detail} /> : null}
      {detail.source === "issue" || detail.source === "intent" ? (
        <IssueChange detail={detail} />
      ) : null}
      {detail.source === "craft" ? <CraftDetails detail={detail} /> : null}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-xs font-medium text-fg-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** What the effect is counted on, under the big figure. */
function effectCaption(fix: Fix): string | null {
  const effect = fix.effect;
  if (!effect) return null;
  if (effect.basis === "replay")
    return effect.detail
      ? `${effect.detail}, in a replay of past searches`
      : "In a replay of past searches";
  const window = fix.detail.source === "craft" ? fix.detail.worthCaption : null;
  const parts = [effect.detail, window].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? capitalize(parts.join(", ")) : null;
}

/** The kind's mark, the effect as a big figure (else what the issue costs today), the evidence, and what to do. */
function Hero({ fix, actions }: { fix: Fix; actions: ReactNode }) {
  const Icon = FIX_KIND_ICONS[fix.kind];
  const caption = effectCaption(fix);
  // Not measured: the size of the problem it removes, as Agent health counts it, says what it is worth.
  const today = fix.effect
    ? null
    : (fix.issues.find((issue) => issue.figure !== null)?.figure ?? null);
  return (
    <section
      aria-label="What it does"
      className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-app">
          <Icon aria-hidden strokeWidth={1.5} className="size-5 text-fg-muted" />
          <span className="sr-only">{fix.kindLabel}</span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {fix.effect ? (
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-effect-figure="">
              <span className="inline-flex items-center gap-1 self-center">
                <EffectArrow effect={fix.effect} className="size-4" />
              </span>
              <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
                {fix.effect.figure}
              </span>
              {fix.effect.unit ? (
                <span className="text-sm text-fg-muted">{fix.effect.unit}</span>
              ) : null}
            </p>
          ) : today ? (
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-today-figure="">
              <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
                {today.display}
              </span>
              <span className="text-sm text-fg-muted">{today.caption}</span>
            </p>
          ) : (
            <p className="text-sm text-fg-muted">Not measured yet</p>
          )}
          {caption ? <p className="text-xs text-fg-subtle tabular-nums">{caption}</p> : null}
          {today ? <p className="text-xs text-fg-subtle">Today, before the fix</p> : null}
          {fix.evidence ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs">
              <EvidenceValue evidence={fix.evidence} className="font-medium" />
              <span className="text-fg-subtle tabular-nums">{fix.evidence.detail}</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </section>
  );
}

/** A rewrite's searchable description before and after, with the change marked in each; once applied, the after is now. */
function BeforeAfter({ detail, applied }: { detail: RewriteDetail; applied: boolean }) {
  const { row } = detail;
  return (
    <DetailSection title="Searchable description">
      <div className="flex flex-col gap-2" data-diff="">
        <figure className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5">
          <figcaption className="text-xs text-fg-subtle">{applied ? "Before" : "Now"}</figcaption>
          <p className="text-sm leading-6 text-fg-muted">
            {row.spans.map((span, index) =>
              span.op === "added" ? null : span.op === "same" ? (
                <span key={index}>{span.text}</span>
              ) : (
                <del key={index} className="rounded-sm bg-danger-subtle px-0.5 text-fg-muted">
                  {span.text}
                </del>
              ),
            )}
          </p>
        </figure>
        <figure className="flex flex-col gap-1 rounded-lg border border-line-strong bg-raised px-3 py-2.5">
          <figcaption className="flex items-center gap-2 text-xs text-fg-subtle">
            <span className="flex-1">{applied ? "Now, applied" : "After the rewrite"}</span>
            <CopyButton text={row.proposed} label="Copy the new description" />
          </figcaption>
          <p className="text-sm leading-6 text-fg-muted">
            {row.spans.map((span, index) =>
              span.op === "removed" ? null : span.op === "same" ? (
                <span key={index}>{span.text}</span>
              ) : (
                <ins
                  key={index}
                  className="rounded-sm bg-success-subtle px-0.5 text-fg no-underline"
                >
                  {span.text}
                </ins>
              ),
            )}
          </p>
        </figure>
        {row.rationale ? <p className="text-xs text-fg-subtle">{row.rationale}</p> : null}
        {detail.caveat ? (
          <p className="flex items-start gap-2 text-xs text-fg-muted" data-caveat="runtime">
            <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" />
            {detail.caveat}
          </p>
        ) : null}
      </div>
    </DetailSection>
  );
}

const LINK =
  "inline-flex shrink-0 items-center gap-1 rounded-md text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

/** Issues listed before "And N more": the worst ones, which the list is ordered by. */
const ISSUES_SHOWN = 3;

/** The issues it resolves as compact rows, each opening on Agent health; without one, the source's own why. */
function IssuesSection({ fix }: { fix: Fix }) {
  if (fix.issues.length === 0) {
    const lines =
      fix.detail.source === "craft" && fix.detail.why.length > 0 ? fix.detail.why : [fix.why];
    return (
      <DetailSection title="Why">
        <ul className="flex flex-col gap-1">
          {lines.map((line) => (
            <li key={line} className="text-ui text-fg-muted tabular-nums">
              {line}
            </li>
          ))}
        </ul>
      </DetailSection>
    );
  }
  const shown = fix.issues.slice(0, ISSUES_SHOWN);
  const more = fix.issues.length - shown.length;
  return (
    <DetailSection
      title={
        fix.issues.length === 1
          ? "The issue it resolves"
          : `The ${fix.issues.length} issues it resolves`
      }
    >
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
        {shown.map((issue) => (
          <li key={issue.id}>
            <Link
              href={issue.href}
              className="group flex min-h-10 items-center gap-2.5 px-3 py-2 outline-none transition-colors duration-120 hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[inset_2px_0_0_var(--ds-focus)]"
            >
              <NounIcon noun="issue" />
              {/* The title, and its sentence on one quiet line: two issues of one kind stay apart by their tools. */}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui text-fg">{issue.title}</span>
                <span className="truncate text-xs text-fg-subtle">{issue.claim}</span>
              </span>
              {issue.figure ? (
                <span className="shrink-0 text-xs whitespace-nowrap tabular-nums">
                  <span className="font-medium text-fg">{issue.figure.display}</span>{" "}
                  <span className="text-fg-subtle">{issue.figure.caption}</span>
                </span>
              ) : null}
              <ArrowUpRight
                aria-hidden
                className="size-3.5 shrink-0 text-fg-subtle group-hover:text-fg"
              />
              <span className="sr-only">Open in Agent health</span>
            </Link>
          </li>
        ))}
        {more > 0 ? (
          <li className="px-3 py-2">
            {/* The others are on Agent health, worst first, like these. */}
            <Link href={issueListHref(fix.issues[0]!.href)} className={LINK}>
              And {more} more {more === 1 ? "issue" : "issues"} in Agent health
              <ArrowUpRight aria-hidden className="size-3" />
            </Link>
          </li>
        ) : null}
      </ul>
    </DetailSection>
  );
}

/** A drafted change: its small drawing, the steps on your side, and the code to ship. */
function CraftChange({ fix, detail }: { fix: Fix; detail: CraftDetail }) {
  return (
    <DetailSection title="The change">
      <div
        className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2"
        data-fix-motion=""
      >
        <style>{KIND_MOTION_STYLES}</style>
        <KindMotion kind={detail.craftKind} />
        <p className="text-xs text-fg-subtle">
          {detail.plain || `${fix.kindLabel}, as it changes your agent's calls.`}
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-ui text-fg-muted marker:text-fg-subtle">
        {detail.change.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {detail.crafted.map((tool) => (
        <CodeBlock
          key={tool.name}
          caption={tool.name}
          samples={[
            { label: "JSON", code: tool.json },
            { label: "TypeScript", code: tool.typescript },
            { label: "Python", code: tool.python },
          ]}
        />
      ))}
    </DetailSection>
  );
}

/** A fix an issue asks for, or an intent's own: the change it names, made in your agent, tool server or skills. */
function IssueChange({ detail }: { detail: Pick<IssueDetail, "changes" | "caveat"> }) {
  return (
    <DetailSection title="The change">
      <ul className="flex flex-col gap-1.5">
        {detail.changes.map((change) => (
          <li key={change} className="text-ui text-fg">
            {change}
          </li>
        ))}
      </ul>
      {detail.caveat ? (
        <p className="flex items-start gap-2 text-xs text-fg-muted">
          <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" />
          {detail.caveat}
        </p>
      ) : null}
    </DetailSection>
  );
}

const REPLAY: Record<
  "better" | "same" | "worse",
  { tone: "success" | "neutral" | "warning"; label: string }
> = {
  better: { tone: "success", label: "Better in a replay of past searches" },
  same: { tone: "neutral", label: "No clear change in a replay of past searches" },
  worse: { tone: "warning", label: "Worse in a replay of past searches" },
};

/** The specialist's numbers: how the effect adds up, the facts it stands on, and the tools as declared today. */
function CraftDetails({ detail }: { detail: CraftDetail }) {
  const hasWorth = detail.worth.length > 0 || detail.replay !== null;
  if (!hasWorth && detail.facts.length === 0 && detail.sources.length === 0) return null;
  return (
    <Disclosure
      title="Details"
      hint="How it adds up, and the tools today"
      className="border-t border-line pt-3"
    >
      <div className="flex flex-col gap-5">
        {hasWorth ? (
          <DetailSection title="How it adds up">
            {detail.worth.length > 0 ? (
              <ul className="flex flex-col">
                {detail.worth.map((chip, index) => {
                  const Icon = EFFECT_ICONS[chip.icon];
                  return (
                    <li
                      key={`${chip.icon}:${index}`}
                      className="flex items-start gap-2 border-b border-line py-2 last:border-b-0"
                    >
                      <Icon
                        aria-hidden
                        strokeWidth={1.5}
                        className="mt-0.5 size-4 shrink-0 text-fg-subtle"
                      />
                      <div className="min-w-0">
                        <p className="text-ui text-fg tabular-nums">{chip.text}</p>
                        {chip.title ? <p className="text-xs text-fg-subtle">{chip.title}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {detail.worthCaption ? (
              <p className="text-xs text-fg-subtle tabular-nums">
                {capitalize(detail.worthCaption)}
              </p>
            ) : null}
            {detail.replay ? (
              <StatusDot
                tone={REPLAY[detail.replay.verdict].tone}
                label={REPLAY[detail.replay.verdict].label}
              />
            ) : null}
          </DetailSection>
        ) : null}
        {detail.facts.length > 0 ? (
          <DetailSection title="What it stands on">
            <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui">
              {detail.facts.map((fact) => (
                <div key={`${fact.label}:${fact.value}`} className="contents">
                  <dt className="text-fg-subtle">{capitalize(fact.label)}</dt>
                  <dd className="min-w-0 break-words text-fg-muted tabular-nums">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </DetailSection>
        ) : null}
        {detail.sources.length > 0 ? (
          <DetailSection title="Tools today">
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {detail.sources.map((tool) => (
                <li key={tool.id} className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="font-mono text-xs text-fg">{tool.name}</span>
                  {tool.description ? (
                    <span className="line-clamp-3 text-xs text-fg-muted">{tool.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}
      </div>
    </Disclosure>
  );
}

/** Agent health's issue list, from one issue's link (`/health#signal-<id>`). */
function issueListHref(issueHref: string): string {
  return issueHref.replace(/#.*$/, "");
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}
