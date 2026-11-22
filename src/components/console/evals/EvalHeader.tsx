import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Crumb, PageHeader } from "@ratel/design-system/page-header";
import { TabNav } from "@ratel/design-system/tabs";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { editEvalHref, evalHref, evalRunHref, evalsHref } from "@/lib/views/evals/paths";
import { ResultStatus } from "./marks";
import { RemoveEvalButton } from "./RemoveEvalButton";

/**
 * One eval's header (D1): breadcrumb, its result, "17 of 20" with ← and →
 * inside a run, Edit (RC-297), Remove (RC-315), and the Last run / Runs /
 * Definition tabs. RC-657: "Edit eval" is the one primary action; Remove is in
 * the "More actions" menu.
 */
export function EvalHeader({
  projectId,
  evalId,
  name,
  passed,
  runCount,
  runId,
  runLabel,
  position,
  editing = false,
}: {
  projectId: string;
  evalId: string;
  name: string;
  passed?: boolean | null;
  runCount: number;
  runId?: string | null;
  runLabel?: string | null;
  position?: { index: number; total: number; prev: string | null; next: string | null } | null;
  /** The editor is open: no Edit link and no Remove. */
  editing?: boolean;
}) {
  const crumbs: Crumb[] = [{ label: "Evals", href: evalsHref(projectId) }];
  if (runId && runLabel)
    crumbs.push(
      { label: "Runs", href: evalsHref(projectId, { tab: "runs" }) },
      { label: runLabel, href: evalRunHref(projectId, runId) },
    );
  const base = `/project/${encodeURIComponent(projectId)}/evals/${encodeURIComponent(evalId)}`;
  return (
    <PageHeader
      crumbs={crumbs}
      title={name}
      actions={
        <>
          {passed === undefined ? null : (
            <ResultStatus mark={passed === null ? "error" : passed ? "pass" : "fail"} />
          )}
          {position && runId ? (
            <span className="flex items-center gap-1">
              <span className="text-ui text-fg-muted tabular-nums">
                {position.index} of {position.total}
              </span>
              <NavLink
                href={position.prev ? evalHref(projectId, position.prev, { run: runId }) : null}
                label="Previous eval"
              >
                <ArrowLeft />
              </NavLink>
              <NavLink
                href={position.next ? evalHref(projectId, position.next, { run: runId }) : null}
                label="Next eval"
              >
                <ArrowRight />
              </NavLink>
            </span>
          ) : null}
          {editing ? null : (
            <Link
              href={editEvalHref(projectId, evalId)}
              className={buttonVariants({ variant: "primary", size: "sm" })}
            >
              Edit eval
            </Link>
          )}
          {editing ? null : <RemoveEvalButton projectId={projectId} evalId={evalId} name={name} />}
        </>
      }
      tabs={
        <TabNav
          label="Eval"
          tabs={[
            {
              href: runId ? `${base}?run=${encodeURIComponent(runId)}` : base,
              label: runId ? "This run" : "Last run",
              exact: true,
            },
            { href: `${base}/runs`, label: "Runs", meta: runCount },
            { href: `${base}/definition`, label: "Definition" },
          ]}
        />
      }
    />
  );
}

/** ← or → between the evals of a run; a plain mark at either end. */
export function NavLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: ReactNode;
}) {
  if (!href)
    return (
      <span
        aria-disabled
        className={buttonVariants({ variant: "ghost", size: "sm" }) + " opacity-40"}
        aria-label={label}
      >
        {children}
      </span>
    );
  return (
    <Link
      href={href}
      aria-label={label}
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      {children}
    </Link>
  );
}
