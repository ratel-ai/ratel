import { cn } from "@ratel/design-system/cn";
import { RadioTower } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { planName } from "@/lib/platform/entitlements";
import {
  agentHealthHref,
  type WindowDays,
  type WindowOption,
  windowPhrase,
} from "@/lib/readings/trace-signals/view";
import { planWithWindow } from "@/lib/views/health/page-state";

export interface HealthHeaderProps {
  projectId: string;
  projectName: string;
  windowDays: WindowDays;
  /** From `windowOptionsForPlan`: locked options render disabled with a chip naming the plan that has them. */
  windowOptions: readonly WindowOption[];
  /** From `evidenceChipText`, e.g. "1,284 turns · tools only"; null hides the chip. */
  evidence: string | null;
  /** From `sourceBadgeText`: "From OpenTelemetry" or "SDK + OpenTelemetry"; null (the SDK page) shows none. */
  source?: string | null;
  /** Buttons beside the window control (Share, Download PDF); none on a shared page. */
  actions?: ReactNode;
  /**
   * The public copy: the window is fixed by the link, so it reads as a label
   * rather than a control, and the eyebrow names the organization.
   */
  shared?: { organizationName: string } | null;
}

/** The page header: eyebrow, title, one line of what this is, and the window picker. */
export function HealthHeader({
  projectId,
  projectName,
  windowDays,
  windowOptions,
  evidence,
  source = null,
  actions = null,
  shared = null,
}: HealthHeaderProps) {
  return (
    <header className="pixel-header card-enter flex flex-wrap items-end justify-between gap-x-10 gap-y-6 border-b border-forest-300 pb-7">
      <div className="min-w-0 max-w-2xl">
        <div className="eyebrow">{shared ? `Shared by ${shared.organizationName}` : "Project"}</div>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-cream">
          Agent health
        </h1>
        <p className="mt-3 text-sm leading-6 text-warm-muted">
          What {projectName} struggled with {windowPhrase(windowDays)}, read from its own traces.
          Green is working. Coral and amber are worth a look.
        </p>
      </div>
      <div className="ml-auto flex flex-col items-end gap-3">
        {/* The page's actions get a row of their own, so they never crowd the window control. */}
        {actions && (
          <div className="flex flex-wrap items-center justify-end gap-2" data-health-actions="true">
            {actions}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {shared ? (
            <span
              data-health-window-fixed={windowDays}
              className="rounded-full border border-forest-300 bg-base-deep/50 px-3.5 py-1.5 text-sm font-medium text-cream-dim"
            >
              {windowDays === 7 ? "Last 7 days" : `Last ${windowDays} days`}
            </span>
          ) : (
            <HealthWindowControl
              projectId={projectId}
              windowDays={windowDays}
              options={windowOptions}
            />
          )}
        </div>
        {source ? (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <span
              data-health-source={source}
              className="inline-flex items-center gap-1.5 rounded-full border border-forest-300 bg-base-deep/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-cream-dim"
            >
              <RadioTower className="size-3 text-warm-muted" aria-hidden />
              {source}
            </span>
            {evidence && <EvidenceChip text={evidence} />}
          </div>
        ) : (
          evidence && <EvidenceChip text={evidence} />
        )}
      </div>
    </header>
  );
}

function EvidenceChip({ text }: { text: string }) {
  return (
    <span className="eyebrow" data-health-evidence="true">
      {text}
    </span>
  );
}

export interface HealthWindowControlProps {
  projectId: string;
  windowDays: WindowDays;
  options: readonly WindowOption[];
}

/**
 * 7d / 30d / 90d as links, because the window is URL state (`?days=`), styled
 * as the app's segmented pill. A window the plan does not include is not a link
 * at all: it renders disabled with a small chip naming the plan that has it
 * ("Plus" for 30 days, "Pro" for 90).
 */
export function HealthWindowControl({ projectId, windowDays, options }: HealthWindowControlProps) {
  return (
    <div
      role="group"
      aria-label="Window"
      className="inline-flex rounded-full border border-forest-300 bg-base-deep/50 p-0.5"
    >
      {options.map((option) => {
        const active = option.days === windowDays;
        const base =
          "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors";
        if (option.locked) {
          // The plan that has this window: 30 days are on Plus, 90 on Pro. Owned: the plans are the
          // entitlements port's, so without an edition's plans the chip is left out.
          const planId = planWithWindow(option.days);
          const plan = planId ? planName(planId) : null;
          return (
            <span
              key={option.days}
              aria-disabled="true"
              title={plan ? `${option.days} days are on ${plan}` : undefined}
              className={cn(base, "cursor-not-allowed text-warm-muted/50")}
            >
              {option.label}
              {plan ? (
                <span className="rounded-full border border-forest-300 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-warm-muted">
                  {plan}
                </span>
              ) : null}
            </span>
          );
        }
        return (
          <Link
            key={option.days}
            href={agentHealthHref(projectId, option.days)}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={cn(base, active ? "bg-cream text-ink" : "text-warm-muted hover:text-cream")}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}
