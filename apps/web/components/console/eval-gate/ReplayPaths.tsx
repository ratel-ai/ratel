import { StatusDot } from "@ratel/design-system/badge";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ReplayPathsView } from "@/lib/views/eval-gate/replay-paths";

/** One replayed run: where it links, how it is labeled, and its paths. */
export interface ReplayPathsItem {
  id: string;
  turnId: string;
  runHref: string;
  /** The run's place in the simulation, in words ("Task set", "Issue's run · not counted"). */
  label: string;
  paths: ReplayPathsView;
}

/**
 * What the replay did (RC-76): per replayed run, the tools the run called as
 * recorded, and as the replay called them without and with the fix. A run is
 * scored only when the side without the fix took the recorded path. Shared by
 * the per-fix eval page and the task simulation page.
 */
export function ReplayPathsSection({
  rows,
  names,
}: {
  rows: readonly ReplayPathsItem[];
  names: ReadonlyMap<string, string>;
}) {
  const baselines = rows.filter((row) => row.paths.baseline).length;
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          What the replay did
          <span className="font-normal text-fg-subtle tabular-nums">
            {baselines} of {rows.length} on the recorded path
          </span>
        </span>
      }
      description="The tools each run called, in order: as recorded, then as the model called them without and with the fix. A run counts only when the replay without the fix took the recorded path."
    >
      <ul
        className="divide-y divide-line overflow-hidden rounded-lg border border-line"
        data-replay-paths
      >
        {rows.map((row) => (
          <ReplayPathsRow key={row.id} row={row} names={names} />
        ))}
      </ul>
    </Section>
  );
}

function ReplayPathsRow({
  row,
  names,
}: {
  row: ReplayPathsItem;
  names: ReadonlyMap<string, string>;
}) {
  const paths = row.paths;
  return (
    <li className="grid gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[10rem_1fr]">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={row.runHref}
          className="truncate rounded-md font-mono text-xs text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          title={row.turnId}
        >
          {row.turnId.slice(0, 8)}…{row.turnId.slice(-4)}
        </Link>
        <span className="text-xs text-fg-subtle">{row.label}</span>
      </span>
      <dl className="grid min-w-0 grid-cols-[6.5rem_1fr] items-baseline gap-x-3 gap-y-1">
        <PathLine label="Recorded" path={paths.recorded} names={names} />
        <PathLine
          label="Without the fix"
          path={paths.before}
          names={names}
          status={
            <StatusDot
              tone={paths.baseline ? "success" : "warning"}
              label={paths.baseline ? "Recorded path" : "Another path: not scored"}
              className="text-xs"
            />
          }
          stop={paths.stops?.before}
        />
        <PathLine
          label="With the fix"
          path={paths.after}
          names={names}
          status={
            paths.doesTheWork === null ? null : (
              <StatusDot
                tone={paths.doesTheWork ? "success" : "danger"}
                label={paths.doesTheWork ? "Does the run's work" : "Doesn't do the run's work"}
                className="text-xs"
              />
            )
          }
          stop={
            paths.doesTheWork === false && paths.workDetail
              ? paths.workDetail.replace(/^./, (c) => c.toUpperCase())
              : (paths.stops?.after ?? (paths.after ? undefined : "Not replayed: no baseline"))
          }
        />
        {paths.intended && paths.after?.join(" ") !== paths.intended.join(" ") ? (
          <PathLine label="Fix intends" path={paths.intended} names={names} muted />
        ) : null}
      </dl>
    </li>
  );
}

function PathLine({
  label,
  path,
  names,
  status = null,
  stop,
  muted = false,
}: {
  label: string;
  path: string[] | null;
  names: ReadonlyMap<string, string>;
  status?: ReactNode;
  stop?: string;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {path === null ? null : path.length === 0 ? (
          <span className="text-xs text-fg-muted">No tool calls</span>
        ) : (
          <span className={`font-mono text-xs break-words ${muted ? "text-fg-muted" : "text-fg"}`}>
            {path.map((id) => names.get(id) ?? id).join(" → ")}
          </span>
        )}
        {status}
        {stop ? <span className="text-xs text-fg-faint">{stop}</span> : null}
      </dd>
    </>
  );
}
