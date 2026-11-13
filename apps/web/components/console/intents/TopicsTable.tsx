"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { DotMeter, DotSpark } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin } from "@ratel/design-system/entity";
import { usePeek } from "@ratel/design-system/panel";
import type { TableSort } from "@ratel/design-system/table-model";
import { ArrowDown, ArrowUp, ChevronRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AskIcon, ExampleSourceIcon, InfoMark } from "@/components/console/intents/marks";
import { SentimentBar, SentimentLegend } from "@/components/console/intents/SentimentBar";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import { type IntentDetailLoad, TopicPanel } from "@/components/console/intents/TopicPanel";
import { useOnDemand } from "@/components/console/intents/use-on-demand";
import { captureClientException } from "@/lib/platform/track-client";
import type { BreakdownRow, IntentBreakdownSummary } from "@/lib/views/intents/breakdown";
import type { ExampleAsk } from "@/lib/views/intents/topics-examples";
import {
  ANSWERED_MEANS,
  SENTIMENT_MEANS,
  sentimentHowRead,
} from "@/lib/views/intents/topics-explain";
import {
  parseTopicSort,
  sortTopics,
  type TopicSort,
  type TopicsSummary,
  type TopicView,
} from "@/lib/views/intents/topics-view";

const n = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Reads one example ask per intent, by intent id (`loadIntentLeadsAction`). */
export type LeadsLoad = () => Promise<
  { ok: true; leads: Record<string, ExampleAsk> } | { ok: false; message: string }
>;

export type Leads =
  | { status: "loading" }
  | { status: "ready"; leads: Record<string, ExampleAsk> }
  | { status: "error" };

/** Reads what each intent's asks are for, by intent id (`loadIntentRowsAction`). */
export type RowsLoad = () => Promise<
  { ok: true; rows: Record<string, IntentBreakdownSummary> } | { ok: false; message: string }
>;

/** Rows an open intent shows under it at most; its panel lists the rest. */
export const TABLE_CHILDREN = 5;

/** A line of the table: an intent, or (opened under it) one thing its asks are for, or how many more its panel lists. */
export type IntentTableRow =
  | {
      kind: "intent";
      topic: TopicView;
      children: number /** Its rows are the ways people ask it: what they ask for is one thing. */;
      skipped: boolean;
    }
  | { kind: "child"; topic: TopicView; row: BreakdownRow }
  | { kind: "more"; topic: TopicView; count: number };

/**
 * The intents in their order, each open one followed by what its asks are
 * for (or, with that level skipped, the ways people ask it), the busiest
 * few, and how many more its panel lists. An intent opens when it has two
 * rows or more: one alone says nothing its name doesn't.
 */
export function intentTableRows(
  topics: readonly TopicView[],
  open: ReadonlySet<string>,
  summaries: Readonly<Record<string, IntentBreakdownSummary>> | null,
): IntentTableRow[] {
  return topics.flatMap((topic): IntentTableRow[] => {
    const summary = summaries?.[topic.id];
    const children = summary && summary.children > 1 ? summary.children : 0;
    const head: IntentTableRow = {
      kind: "intent",
      topic,
      children,
      skipped: summary?.skipped ?? false,
    };
    if (!summary || children === 0 || !open.has(topic.id)) return [head];
    const shown = summary.rows.slice(0, TABLE_CHILDREN);
    const rest = summary.children - shown.length;
    return [
      head,
      ...shown.map((row): IntentTableRow => ({ kind: "child", topic, row })),
      ...(rest > 0 ? [{ kind: "more", topic, count: rest } satisfies IntentTableRow] : []),
    ];
  });
}

function rowKeyOf(row: IntentTableRow): string {
  if (row.kind === "intent") return row.topic.id;
  return row.kind === "child"
    ? `${row.topic.id}/${row.row.kind}:${row.row.id}`
    : `${row.topic.id}/more`;
}

/** Each sort and how its header shows it. */
const SORTS: Record<TopicSort, TableSort> = {
  turns: { id: "turns", direction: "desc" },
  name: { id: "name", direction: "asc" },
  answered: { id: "answered", direction: "asc" },
  negative: { id: "sentiment", direction: "desc" },
};

/**
 * Each intent's example ask, read once the list is on screen (captured text
 * stays out of the stored reading and the server-rendered page; it is read on
 * demand from the turns' own events). Read again only when the intents change.
 */
function useLeads(load: LeadsLoad, key: string): Leads {
  const pathname = usePathname();
  const [state, setState] = useState<Leads>({ status: "loading" });
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  // A bound server action arrives as a new copy after every refresh; following its identity would read forever.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (result) => {
        if (!cancelled)
          setState(result.ok ? { status: "ready", leads: result.leads } : { status: "error" });
      },
      (error: unknown) => {
        // Reported, never dropped: the action answers its own failures, so this is a bug or an outage.
        captureClientException(error, {
          digest: null,
          pathname: pathRef.current ?? "",
          boundary: "app",
        });
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state;
}

/** The second line of a row: one example ask in quotes, or the intent's description when none was captured. */
export function IntentLead({ leads, topic }: { leads: Leads; topic: TopicView }) {
  // The line keeps its height while the example is read, so nothing moves when it lands.
  if (leads.status === "loading") return null;
  const lead = leads.status === "ready" ? leads.leads[topic.id] : undefined;
  if (lead) {
    return (
      <>
        <ExampleSourceIcon source={lead.source} className="size-3" />
        <span className="min-w-0 truncate text-fg-muted">“{lead.text}”</span>
      </>
    );
  }
  return topic.description ? (
    <span className="min-w-0 truncate text-fg-subtle">{topic.description}</span>
  ) : null;
}

/**
 * Opens an intent's row onto what its asks are for. Its name stays the same
 * open or closed (`aria-expanded` says which) and carries the intent's name
 * as text, so a list of them reads apart.
 */
export function RowToggle({
  name,
  skipped,
  open,
  count,
  onToggle,
}: {
  name: string;
  skipped: boolean;
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="-mx-1 inline-flex size-6 items-center justify-center rounded-md text-fg-subtle outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
    >
      <ChevronRight
        aria-hidden
        strokeWidth={1.5}
        className={cn(
          "size-3.5 transition-transform duration-160 ease-enter motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
      <span className="sr-only">
        {name}: {skipped ? "ways people ask it" : "what they ask for"}, {n(count)}
      </span>
    </button>
  );
}

/** An intent's name, with its example ask (or its description) under it. */
function IntentName({ topic, leads }: { topic: TopicView; leads: Leads }) {
  return (
    <span className="flex min-w-0 flex-col gap-1 py-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <NounIcon noun="intent" />
        {/* On a phone the name wraps: the numbers beside it leave it little room. */}
        <span className="truncate font-medium text-fg max-md:break-words max-md:whitespace-normal">
          {topic.name}
        </span>
      </span>
      <span className="flex h-4 min-w-0 items-center gap-1.5 pl-5 text-xs">
        <IntentLead leads={leads} topic={topic} />
      </span>
    </span>
  );
}

/** An intent's asks with a quiet trend, and the conversations they were asked in. */
function IntentAsks({ topic }: { topic: TopicView }) {
  return (
    <span className="flex flex-col items-end gap-1 py-2">
      <span className="inline-flex items-center gap-3">
        <DotSpark
          values={topic.trend}
          rows={4}
          label="Asks every two days over the last 30 days"
          className="max-lg:hidden"
        />
        <span>
          {n(topic.turns)}{" "}
          <span className="text-fg-subtle max-sm:sr-only">
            {topic.turns === 1 ? "ask" : "asks"}
          </span>
        </span>
      </span>
      {typeof topic.conversations === "number" ? (
        <span className="inline-flex h-4 items-center gap-1 text-xs text-fg-subtle max-sm:hidden">
          in
          <NounIcon noun="conversation" className="size-3" />
          {n(topic.conversations)} {topic.conversations === 1 ? "conversation" : "conversations"}
        </span>
      ) : null}
    </span>
  );
}

/** One thing an open intent's asks are for, under its name: by the name a model gave it, or as an ask, quoted. */
function ChildName({ row }: { row: Extract<IntentTableRow, { kind: "child" | "more" }> }) {
  if (row.kind === "more") {
    return (
      <span className="block py-1.5 pl-5 text-xs text-fg-subtle tabular-nums">
        and {n(row.count)} more
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 py-1.5 pl-5">
      {row.row.quoted ? <AskIcon className="size-3" /> : null}
      <span className="truncate text-fg-muted">
        {row.row.quoted ? `“${row.row.label}”` : row.row.label}
      </span>
    </span>
  );
}

/** The main task as its pin, and how many more share the intent (all of them in the panel). */
function TaskPins({ tasks }: { tasks: TopicView["tasks"] }) {
  const [main, ...rest] = tasks;
  if (!main) return <span className="text-xs text-fg-faint">No task</span>;
  return (
    <span className="flex max-w-64 min-w-0 items-center gap-1.5">
      <TaskPin name={main.name} slot={main.slot} href={main.href} className="shrink" />
      {rest.length > 0 ? (
        <span className="text-xs text-fg-subtle tabular-nums">
          +{rest.length}
          <span className="sr-only"> more {rest.length === 1 ? "task" : "tasks"}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * A sortable header with an info mark beside it. The mark can't sit inside
 * the sort link (a button in a link), so the header draws its own link, the
 * same as DataTable's, and the mark after it.
 */
function SortHeader({
  label,
  href,
  onSort,
  direction,
  info,
}: {
  label: string;
  href: string;
  onSort: () => void;
  direction: "asc" | "desc" | null;
  info: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    onSort();
  };
  return (
    <span className="-my-1 inline-flex items-center">
      <Link
        href={href}
        scroll={false}
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 rounded outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus",
          direction && "text-fg",
        )}
      >
        {label}
        {direction === "asc" ? <ArrowUp className="size-3" aria-hidden /> : null}
        {direction === "desc" ? <ArrowDown className="size-3" aria-hidden /> : null}
      </Link>
      {info}
    </span>
  );
}

function InfoBody({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium text-fg">{title}</p>
      {children}
    </div>
  );
}

/**
 * Intents as rows (DESIGN.md, Lists): each intent with one example ask under
 * its name, so the grouping explains itself; its asks and the conversations
 * they were asked in, with a quiet trend; how many were answered; how people
 * sound; and the task that handles it, as its pin. Sorted on the client, the
 * sort and the open row in the URL; a row opens the intent's panel, and its
 * chevron opens it in place onto what its asks are for (read once the list
 * is on screen, like the examples). Names and example asks are text only:
 * every attribute carries an id.
 */
export function TopicsTable({
  topics,
  sentimentRead,
  loadExamples,
  loadLeads,
  loadRows,
  loadDetail,
}: {
  topics: readonly TopicView[];
  sentimentRead: TopicsSummary["sentimentRead"];
  loadExamples: ExamplesLoad;
  loadLeads: LeadsLoad;
  loadRows: RowsLoad;
  loadDetail: IntentDetailLoad;
}) {
  const peek = usePeek();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sort = parseTopicSort(searchParams.get("sort"));
  const sorted = useMemo(() => sortTopics(topics, sort), [topics, sort]);
  const order = useMemo(() => sorted.map((row) => row.id), [sorted]);
  const leadsKey = useMemo(() => topics.map((topic) => topic.id).join(","), [topics]);
  const leads = useLeads(loadLeads, leadsKey);
  const summaries = useOnDemand(
    loadRows,
    leadsKey,
    "Couldn't load what these intents' asks are for.",
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const rows = useMemo(
    () =>
      intentTableRows(sorted, open, summaries.status === "ready" ? summaries.result.rows : null),
    [sorted, open, summaries],
  );
  const measured = topics.some((topic) => topic.sentiment && topic.sentiment.measured > 0);

  const hrefFor = useCallback(
    (next: TopicSort) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "turns") params.delete("sort");
      else params.set("sort", next);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );
  const sortBy = (next: TopicSort) => ({
    sortHref: () => hrefFor(next),
    onSort: () => window.history.replaceState(null, "", hrefFor(next)),
  });
  const header = (label: string, next: TopicSort, info: ReactNode) => (
    <SortHeader
      label={label}
      href={hrefFor(next)}
      onSort={() => window.history.replaceState(null, "", hrefFor(next))}
      direction={sort === next ? SORTS[next].direction : null}
      info={info}
    />
  );

  // An open intent's rows fill its name and asks; the rest of their line stays empty.
  const ofIntent = (cell: (topic: TopicView) => ReactNode) => (row: IntentTableRow) =>
    row.kind === "intent" ? cell(row.topic) : null;

  const columns: Column<IntentTableRow>[] = [
    {
      id: "open",
      header: <span className="sr-only">Open what they ask for</span>,
      // Always this wide, so the names never move when the rows arrive.
      width: "2.25rem",
      className: "pr-0",
      cell: (row) =>
        row.kind === "intent" && row.children > 0 ? (
          <RowToggle
            name={row.topic.name}
            skipped={row.skipped}
            open={open.has(row.topic.id)}
            count={row.children}
            onToggle={() => toggle(row.topic.id)}
          />
        ) : null,
    },
    {
      id: "name",
      header: "Intent",
      // Takes the room the numbers leave and truncates in it (a table cell only truncates with a zero max width).
      className: "w-full max-w-0",
      ...sortBy("name"),
      cell: (row) =>
        row.kind === "intent" ? (
          <IntentName topic={row.topic} leads={leads} />
        ) : (
          <ChildName row={row} />
        ),
    },
    {
      id: "turns",
      header: "Asks",
      align: "right",
      className: "whitespace-nowrap",
      ...sortBy("turns"),
      cell: (row) =>
        row.kind === "intent" ? (
          <IntentAsks topic={row.topic} />
        ) : row.kind === "child" ? (
          // A share, not a count: a busy intent's rows are read from its newest asks, so their counts would sit short of its own.
          <span className="text-fg-muted">
            {pct(row.row.share)}
            <span className="sr-only"> of its asks</span>
          </span>
        ) : null,
    },
    {
      id: "answered",
      header: header(
        "Answered",
        "answered",
        <InfoMark label="What answered means">
          <InfoBody title="Answered">
            <p>{ANSWERED_MEANS}</p>
          </InfoBody>
        </InfoMark>,
      ),
      className: "whitespace-nowrap",
      cell: ofIntent((topic) => (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <DotMeter
            value={topic.answeredShare}
            cells={10}
            tone={topic.mostlyUnanswered ? "warning" : "neutral"}
            label={`Answered ${pct(topic.answeredShare)}`}
            className="max-sm:hidden"
          />
          <span className="min-w-9 text-right">{pct(topic.answeredShare)}</span>
          {topic.mostlyUnanswered ? (
            <span className="inline-flex items-center">
              <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
              <span className="sr-only">Mostly unanswered</span>
            </span>
          ) : null}
        </span>
      )),
    },
    ...(measured
      ? [
          {
            id: "sentiment",
            header: header(
              "Sentiment",
              "negative",
              <InfoMark label="How sentiment is read">
                <InfoBody title="Sentiment">
                  <p>{SENTIMENT_MEANS}</p>
                  <p>{sentimentHowRead(sentimentRead)}</p>
                  <SentimentLegend className="pt-1" />
                </InfoBody>
              </InfoMark>,
            ),
            hiddenBelow: "md",
            className: "whitespace-nowrap",
            cell: ofIntent((topic) => <SentimentBar sentiment={topic.sentiment} />),
          } satisfies Column<IntentTableRow>,
        ]
      : []),
    {
      id: "tasks",
      header: "Tasks",
      hiddenBelow: "lg",
      className: "whitespace-nowrap",
      cell: ofIntent((topic) => <TaskPins tasks={topic.tasks} />),
    },
  ];

  return (
    <>
      <DataTable
        caption="Intents"
        columns={columns}
        rows={rows}
        rowKey={rowKeyOf}
        onRowOpen={(row) => peek.open(row.topic.id)}
        selectedKey={peek.id}
        sort={SORTS[sort]}
      />
      <TopicPanel
        topics={topics}
        peekId={peek.id}
        order={order}
        loadExamples={loadExamples}
        loadDetail={loadDetail}
        onOpen={peek.open}
        onClose={peek.close}
      />
    </>
  );
}
