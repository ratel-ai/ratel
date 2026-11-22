import { cn } from "@ratel/design-system/cn";
import { IntentPin, NOUN_ICONS, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  Layers,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { fmtCount } from "@/lib/platform/format";
import {
  ATTENTION_TONE_LABEL,
  type Attention,
  type AttentionItem,
  type AttentionMark,
  type AttentionSubject,
  type AttentionTone,
} from "@/lib/views/home/attention";

/**
 * "Needs attention": one short list across the product, a row per thing
 * that needs a look. A row is its noun's mark (tinted by how urgent it is),
 * a few words, the pins it is about, one number and a chevron; the
 * explanation is on the page it opens.
 */
export function AttentionSection({
  attention,
  healthHref,
}: {
  attention: Attention;
  healthHref: string | null;
}) {
  const { items, moreIssues } = attention;
  return (
    <Section
      title="Needs attention"
      actions={
        moreIssues > 0 && healthHref ? (
          <Link
            href={healthHref}
            className="inline-flex items-center gap-1 rounded-md text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            {fmtCount(moreIssues)} more in Agent health
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null
      }
    >
      {items.length === 0 ? (
        <div className="rounded-lg border border-line">
          <EmptyState
            icon={CircleCheck}
            title="Nothing needs you right now"
            description="Failed runs, issues and fixes show up here."
            className="py-10"
          />
        </div>
      ) : (
        <AttentionList items={items} />
      )}
    </Section>
  );
}

/** Each mark's icon: the product's nouns (DESIGN.md), runs as on Traces, and context. */
const MARK_ICONS: Record<AttentionMark, LucideIcon> = {
  run: Activity,
  issue: NOUN_ICONS.issue,
  task: NOUN_ICONS.task,
  selfCorrection: NOUN_ICONS.selfCorrection,
  intent: NOUN_ICONS.intent,
  fix: NOUN_ICONS.fix,
  context: Layers,
};

const TONE_TEXT: Record<AttentionTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-info",
};

const ROW =
  "group flex min-h-11 items-center gap-3 px-4 py-2 outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset";

export function AttentionList({ items }: { items: readonly AttentionItem[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {items.map((item) => {
        const Icon = MARK_ICONS[item.mark];
        return (
          <li key={item.key}>
            <AttentionLink item={item}>
              <Icon
                aria-hidden
                strokeWidth={1.5}
                className={cn("size-4 shrink-0", TONE_TEXT[item.tone])}
              />
              <span className="sr-only">{ATTENTION_TONE_LABEL[item.tone]}: </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-ui font-medium text-fg">{item.title}</span>
                {item.subject ? <SubjectPins subject={item.subject} /> : null}
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span className="text-sm font-semibold text-fg tabular-nums">
                  {item.figure.value}
                </span>
                <span className="text-xs text-fg-subtle max-md:sr-only">{item.figure.caption}</span>
              </span>
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-fg-faint transition-colors duration-120 group-hover:text-fg-muted"
              />
            </AttentionLink>
          </li>
        );
      })}
    </ul>
  );
}

/** What a row is about, as pins. Not links: the row itself is one. */
function SubjectPins({ subject }: { subject: AttentionSubject }) {
  if (subject.kind === "task") return <TaskPin name={subject.name} slot={subject.slot} />;
  if (subject.kind === "intent") return <IntentPin name={subject.name} />;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {subject.tools.map((tool, index) => (
        <ToolPin key={index} name={tool.name} kind={tool.skill ? "skill" : "tool"} />
      ))}
      {subject.more > 0 ? (
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
          +{fmtCount(subject.more)}
        </span>
      ) : null}
    </span>
  );
}

/** Another page through the router, or a Panel on this one without a round trip. */
function AttentionLink({ item, children }: { item: AttentionItem; children: ReactNode }) {
  if (item.target.kind === "peek") {
    return (
      <PeekLink peek={item.target.peek} className={ROW}>
        {children}
      </PeekLink>
    );
  }
  return (
    <Link href={item.target.href} className={ROW}>
      {children}
    </Link>
  );
}
