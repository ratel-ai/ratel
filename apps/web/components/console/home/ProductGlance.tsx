import { cn } from "@ratel/design-system/cn";
import { IntentPin, type Noun, NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import type { StatDelta } from "@ratel/design-system/stat-row";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import { fmtCount } from "@/lib/platform/format";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import { windowPhrase } from "@/lib/readings/trace-signals/view";
import type {
  FixesGlance,
  Glance,
  IntentsGlance,
  SelfCorrectionsGlance,
  TasksGlance,
} from "@/lib/views/home/glance";
import { NO_VALUE } from "@/lib/views/home/overview-model";

/**
 * The one product at a glance (DESIGN.md, The product's nouns): Intents,
 * Tasks, Self-corrections and Fixes, in the order the story runs. Each tile
 * is its noun's mark, one number and one line with a pin, and opens its page;
 * a pin opens its own thing.
 *
 * PRIVACY: intent, task and tool names are text only, never attributes.
 */
export function ProductGlance({ glance }: { glance: Glance }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="sr-only">
        At a glance
      </h2>
      <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
        <IntentsTile glance={glance.intents} />
        <TasksTile glance={glance.tasks} />
        <SelfCorrectionsTile glance={glance.selfCorrections} />
        <FixesTile glance={glance.fixes} />
      </ul>
    </section>
  );
}

/** Raised above the tile's stretched link, so a pin or a link inside opens its own page. */
const ABOVE = "relative z-[1]";
/** A pin in a tile gives way to the number beside it: its name truncates. */
const FIT = "shrink";

/**
 * A pin and its number, kept together: on a phone they take their own line
 * when the word before them leaves too little room.
 */
function Pinned({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 max-w-full items-center gap-1.5">{children}</span>;
}

function Tile({
  noun,
  label,
  href,
  value,
  unit,
  delta,
  children,
}: {
  noun: Noun;
  label: string;
  href: string;
  value: string;
  unit?: string | null;
  delta?: StatDelta;
  children?: ReactNode;
}) {
  return (
    <li className="group relative isolate flex min-w-0 flex-col bg-app p-4 transition-colors duration-120 hover:bg-hover">
      <Link
        href={href}
        className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-focus focus-visible:after:ring-inset"
      >
        <NounIcon noun={noun} className="text-fg-muted" />
        {label}
        <ChevronRight
          aria-hidden
          className="ml-auto size-3.5 text-fg-faint transition-colors duration-120 group-hover:text-fg-muted"
        />
      </Link>
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</span>
        {unit ? <span className="text-xs text-fg-subtle">{unit}</span> : null}
        {delta ? <Delta {...delta} /> : null}
      </p>
      <div className="mt-2 flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-subtle sm:flex-nowrap">
        {children}
      </div>
    </li>
  );
}

/** A change next to a tile's number: an arrow and the signed figure, colored only when the direction is good or bad. */
function Delta({ value, direction, good, label }: StatDelta) {
  const Icon =
    direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  const tone =
    good === null || direction === "flat"
      ? "text-fg-subtle"
      : good
        ? "text-success"
        : "text-danger";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", tone)}
      title={label}
    >
      <Icon className="size-3" aria-hidden />
      {value}
      {label ? <span className="sr-only"> {label}</span> : null}
    </span>
  );
}

/** A quiet line in place of a pin: why there is no number yet. */
function Note({ children }: { children: ReactNode }) {
  return <span className="truncate">{children}</span>;
}

const FAILED = "Couldn't load";

function IntentsTile({ glance }: { glance: IntentsGlance }) {
  const ready = glance.state === "ready";
  return (
    <Tile
      noun="intent"
      label="Intents"
      href={glance.href}
      value={ready ? fmtCount(glance.count) : NO_VALUE}
    >
      {glance.state === "failed" ? (
        <Note>{FAILED}</Note>
      ) : glance.top ? (
        <>
          <span className="shrink-0">Top</span>
          <Pinned>
            <IntentPin name={glance.top.name} href={glance.top.href} className={cn(ABOVE, FIT)} />
          </Pinned>
        </>
      ) : (
        <Note>No intents yet</Note>
      )}
    </Tile>
  );
}

const TASKS_BLOCKED: Record<NonNullable<TasksGlance["blocked"]>, string> = {
  mixed_runs: "Runs mix several requests",
  no_tool_calls: "No tool calls yet",
};

function TasksTile({ glance }: { glance: TasksGlance }) {
  const ready = glance.state === "ready" && glance.count > 0 && glance.finishRate !== null;
  return (
    <Tile
      noun="task"
      label="Tasks"
      href={glance.href}
      value={ready && glance.finishRate !== null ? formatSharePercent(glance.finishRate) : NO_VALUE}
      unit={ready ? "finish rate" : null}
    >
      {glance.state === "failed" ? (
        <Note>{FAILED}</Note>
      ) : glance.state === "blocked" && glance.blocked ? (
        <Note>{TASKS_BLOCKED[glance.blocked]}</Note>
      ) : glance.state !== "ready" ? (
        <Note>No tasks yet</Note>
      ) : glance.count === 0 ? (
        <Note>No task repeats yet</Note>
      ) : glance.weakest ? (
        <>
          <span className="shrink-0">Weakest</span>
          <Pinned>
            <TaskPin
              name={glance.weakest.name}
              slot={glance.weakest.slot}
              href={glance.weakest.href}
              className={cn(ABOVE, FIT)}
            />
            <span className="shrink-0 tabular-nums">
              {formatSharePercent(glance.weakest.finishRate)}
            </span>
          </Pinned>
        </>
      ) : (
        <Note>
          {fmtCount(glance.count)} {glance.count === 1 ? "task" : "tasks"}
        </Note>
      )}
    </Tile>
  );
}

const CORRECTIONS_NOTE: Record<Exclude<SelfCorrectionsGlance["state"], "ready">, string> = {
  not_read: "Not read yet",
  mixed_runs: "Needs turn ids",
  no_turns: "No runs yet",
  unavailable: FAILED,
};

function SelfCorrectionsTile({ glance }: { glance: SelfCorrectionsGlance }) {
  const ready = glance.state === "ready";
  return (
    <Tile
      noun="selfCorrection"
      label="Self-corrections"
      href={glance.href}
      value={ready ? glance.value : NO_VALUE}
      unit={ready ? "per 100 turns" : null}
      delta={glance.delta}
    >
      {glance.state !== "ready" ? (
        <Note>{CORRECTIONS_NOTE[glance.state]}</Note>
      ) : glance.topTool ? (
        <>
          <span className="shrink-0">Most after</span>
          <Pinned>
            <ToolPin name={glance.topTool} className={FIT} />
          </Pinned>
        </>
      ) : (
        <Note>None {windowPhrase(glance.windowDays)}</Note>
      )}
    </Tile>
  );
}

function FixesTile({ glance }: { glance: FixesGlance }) {
  const ready = glance.state === "ready";
  return (
    <Tile
      noun="fix"
      label="Fixes"
      href={glance.href}
      value={ready ? fmtCount(glance.open) : NO_VALUE}
      unit={ready ? "ready" : null}
    >
      {!ready ? (
        <Note>{FAILED}</Note>
      ) : glance.descriptions > 0 ? (
        <Link
          href={glance.descriptionsPageHref}
          className={cn(
            ABOVE,
            "truncate rounded-md text-fg-muted underline decoration-line-strong underline-offset-4 outline-none transition-colors duration-120 hover:text-fg hover:decoration-fg-muted focus-visible:ring-2 focus-visible:ring-focus",
          )}
        >
          {fmtCount(glance.descriptions)} description{" "}
          {glance.descriptions === 1 ? "update" : "updates"} to apply
        </Link>
      ) : glance.open === 0 ? (
        <Note>Nothing to change</Note>
      ) : (
        <Note>No description updates to apply</Note>
      )}
    </Tile>
  );
}
