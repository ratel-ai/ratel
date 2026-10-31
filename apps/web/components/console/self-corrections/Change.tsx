"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { ArrowUpRight, BookOpen, CircleX, Hammer, type LucideIcon, PenLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import type { FixAction } from "@/components/console/self-corrections/fix-actions";
import { FIX_PEEK } from "@/components/console/self-corrections/peeks";
import type { FixPattern } from "@/lib/readings/trace-signals/self-corrections/kinds";
import type { FixView } from "@/lib/views/health/self-corrections/page-model";
import { DESCRIPTION_FIX_LABEL } from "@/lib/views/health/summary/fix-links";

/**
 * What to change: the fix of each open self-correction issue, worst first.
 * A row is the fix's mark, its short title, what it is about (a pin) and
 * the one action: "Update description" on Quality › Descriptions, else "Fix"
 * on Fixes. Why (the issue's own sentence) and the way to the issue open in
 * the row's Panel (`?peek=fix:<issue id>`).
 */

const PATTERN_ICON: Readonly<Record<FixPattern, LucideIcon>> = {
  failed: CircleX,
  empty: BookOpen,
  backtrack: PenLine,
  unanswered: Hammer,
};

export function Change({
  fixes,
  actions,
}: {
  fixes: readonly FixView[];
  actions: Readonly<Record<string, FixAction>>;
}) {
  const peek = usePeek();
  const openId = peek.id?.startsWith(FIX_PEEK) ? peek.id.slice(FIX_PEEK.length) : null;
  const open = fixes.find((fix) => fix.id === openId) ?? null;
  const [shown, setShown] = useState<FixView | null>(open);
  if (open && open !== shown) setShown(open);
  const index = open ? fixes.indexOf(open) : -1;
  const title = (fix: FixView) => actions[fix.id]?.title ?? fix.fix;

  const columns: readonly Column<FixView>[] = [
    {
      id: "fix",
      header: "Fix",
      className: "w-full max-w-0 min-w-40",
      cell: (fix) => <FixCell fix={fix} title={title(fix)} />,
    },
    {
      id: "about",
      header: "About",
      width: "16rem",
      className: "max-md:hidden",
      headerClassName: "max-md:hidden",
      cell: (fix) => <Subject fix={fix} />,
    },
    {
      id: "action",
      header: <span className="sr-only">Action</span>,
      cell: (fix) => <Action action={actions[fix.id]} fix={fix} />,
    },
  ];

  return (
    <Section title={<NounTitle noun="fix">What to change</NounTitle>}>
      {fixes.length === 0 ? (
        <p className="py-1 text-ui text-fg-subtle" data-corrections-fixes="0">
          No tool or task corrects itself often enough to need a fix.
        </p>
      ) : (
        <div data-corrections-fixes={fixes.length}>
          <DataTable
            caption="What to change"
            columns={columns}
            rows={fixes}
            rowKey={(fix) => fix.id}
            selectedKey={open?.id ?? null}
            onRowOpen={(fix) => peek.open(`${FIX_PEEK}${fix.id}`)}
          />
        </div>
      )}
      <Panel
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={shown ? title(shown) : "Fix"}
        subtitle={shown?.reason}
        onPrevious={index > 0 ? () => peek.open(`${FIX_PEEK}${fixes[index - 1]!.id}`) : undefined}
        onNext={
          index >= 0 && index < fixes.length - 1
            ? () => peek.open(`${FIX_PEEK}${fixes[index + 1]!.id}`)
            : undefined
        }
      >
        {shown ? <FixBody fix={shown} action={actions[shown.id]} /> : null}
      </Panel>
    </Section>
  );
}

function FixCell({ fix, title }: { fix: FixView; title: string }) {
  const Icon = PATTERN_ICON[fix.pattern];
  return (
    <span
      className="flex min-w-0 items-center gap-2.5 py-1.5"
      data-corrections-fix={fix.id}
      data-fix-pattern={fix.pattern}
    >
      <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
      <span className="truncate font-medium text-fg">{title}</span>
    </span>
  );
}

function Subject({ fix }: { fix: FixView }) {
  const subject = fix.subject;
  return (
    <span className="flex max-w-64 min-w-0">
      {subject.kind === "task" ? (
        <TaskPin name={subject.name} slot={subject.color} href={subject.href} />
      ) : (
        <ToolPin name={subject.name} kind={subject.entryKind} href={subject.href} />
      )}
    </span>
  );
}

function Action({ action, fix }: { action: FixAction | undefined; fix: FixView }) {
  const description = action?.kind === "description";
  return (
    <Link
      href={action?.href ?? fix.fixesHref}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
      data-corrections-action={description ? "description" : "fix"}
    >
      {description ? <PenLine aria-hidden /> : null}
      {description ? DESCRIPTION_FIX_LABEL : "Fix"}
      {description ? null : <ArrowUpRight aria-hidden />}
    </Link>
  );
}

/** A fix in its Panel: what it is about, why, the change in full, and the way to it and to its issue. */
export function FixBody({ fix, action }: { fix: FixView; action: FixAction | undefined }) {
  const description = action?.kind === "description";
  return (
    <div className="flex flex-col gap-5" data-corrections-fix-detail={fix.id}>
      <Subject fix={fix} />
      <section aria-label="Why" className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-fg">Why</h3>
        <p className="text-ui text-fg">{fix.why}</p>
      </section>
      {action?.title ? (
        <section aria-label="The change" className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-fg">The change</h3>
          <p className="text-ui text-fg-muted">{fix.fix}</p>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={action?.href ?? fix.fixesHref}
          className={buttonVariants({ variant: "primary", size: "sm" })}
        >
          {description ? <PenLine aria-hidden /> : null}
          {description ? DESCRIPTION_FIX_LABEL : "Open fix"}
          {description ? null : <ArrowUpRight aria-hidden />}
        </Link>
        <Link href={fix.issueHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          See issue
        </Link>
      </div>
    </div>
  );
}
