"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { toast } from "@ratel/design-system/toast";
import { ArrowUpRight, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useTransition } from "react";
import { runFixSimulationAction } from "@/app/(console)/project/[projectId]/improvement/fixes/eval-actions";
import type { EvalBadge } from "@/lib/views/eval-gate/types";
import { evalHref, passLine, simulatedLabel, VERDICT_WORDS } from "@/lib/views/eval-gate/view";
import { settle } from "@/lib/views/quality/suggestions";

/**
 * The eval gate in a fix's Panel: before and after on the project's own runs,
 * said to be a simulation, with "Run simulation" and the eval's page. Shown
 * only when `cloud-eval-gate` is on (the page passes no badges otherwise).
 */
export function EvalGateSection({
  projectId,
  fixId,
  badge,
  blocked = null,
}: {
  projectId: string;
  fixId: string;
  badge: EvalBadge | undefined;
  /** RC-77: why the fix has nothing to simulate (`nothingToSimulate`); "Run simulation" is disabled with it. */
  blocked?: string | null;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [pending, startTransition] = useTransition();
  const current = badge ?? { state: "none" as const };
  const href = evalHref(projectId, fixId);

  const run = () =>
    startTransition(async () => {
      const outcome = await settle(() => runFixSimulationAction(projectId, fixId));
      if (!outcome.ok) {
        toast({
          title: "Couldn't start the simulation",
          description: outcome.message,
          tone: "danger",
        });
        return;
      }
      toast({
        title: "Simulation started",
        description:
          "It replays your past runs with the fix applied. Your live agent isn't touched.",
      });
      router.refresh();
    });

  return (
    <section aria-label="Eval gate" className="flex flex-col gap-2" data-eval-gate={current.state}>
      <h3 className="text-xs font-medium text-fg-subtle">Eval gate</h3>
      <div className="flex flex-col gap-3 rounded-lg border border-line px-3 py-3">
        <div className="flex items-start gap-3">
          <FlaskConical
            aria-hidden
            strokeWidth={1.5}
            className="mt-0.5 size-4 shrink-0 text-fg-subtle"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {current.state === "done" && current.verdict === "unreliable" ? (
              <>
                <StatusDot
                  tone={VERDICT_WORDS.unreliable.tone}
                  label={VERDICT_WORDS.unreliable.label}
                  className="text-xs"
                />
                <p className="text-ui text-fg-muted">
                  The replay didn&apos;t re-enact enough of your runs as they were recorded to judge
                  the fix. Open the eval for why.
                </p>
              </>
            ) : current.state === "done" && current.verdict !== "unsupported" ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-lg font-semibold text-fg tabular-nums">
                    {passLine(current.before, current.after)}
                  </span>
                  <span className="text-xs text-fg-subtle">of runs pass, before and after</span>
                </p>
                <StatusDot
                  tone={VERDICT_WORDS[current.verdict].tone}
                  label={VERDICT_WORDS[current.verdict].label}
                  className="text-xs"
                />
                <p className="text-xs text-fg-subtle tabular-nums">
                  {simulatedLabel(current.runs)}. Your live agent isn&apos;t touched.
                  {current.stale ? " The runs changed since; run it again." : ""}
                </p>
              </>
            ) : current.state === "done" ? (
              <p className="text-ui text-fg-muted">
                This kind of fix can&apos;t be simulated yet. Its runs and expected outcomes are
                still yours to set.
              </p>
            ) : current.state === "pending" ? (
              <StatusDot tone="info" label="Simulating on your past runs…" />
            ) : current.state === "failed" ? (
              <StatusDot tone="danger" label="The last simulation failed. Run it again." />
            ) : blocked ? null : (
              <p className="text-ui text-fg-muted">
                Not simulated yet. A simulation replays your past runs with this fix applied, never
                your live agent.
              </p>
            )}
            {blocked ? (
              <p id={reasonId} className="text-ui text-fg-muted">
                {blocked}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            disabled={current.state === "pending" || !!blocked}
            focusableWhenDisabled={!!blocked || pending}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={run}
          >
            {pending ? "Starting…" : current.state === "none" ? "Run simulation" : "Run again"}
          </Button>
          <Link href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open eval
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
