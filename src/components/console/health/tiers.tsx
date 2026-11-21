import { cn } from "@ratel/design-system/cn";
import { Hash, type LucideIcon, Zap } from "lucide-react";
import { TIERS as MATCH_QUALITY_TIERS } from "@/components/console/health/primitives/match-quality-tiers";
import { Tooltip } from "@/components/console/health/primitives/tooltip";
import type { SignalTier } from "@/lib/readings/trace-signals/view";

/**
 * Who decided a figure, as one glyph: counted from traces, scored by the
 * classifier, or decided by a model. The three are never blended, so each
 * figure carries exactly one of these next to it.
 *
 * The judge glyph is match quality's own (`Bot`, indigo, "model decided"), so a
 * reader who learned it there recognises it here without a legend.
 */
export interface HealthTierStyle {
  Icon: LucideIcon;
  /** Text colour for the glyph. */
  tone: string;
  /** Two or three words; also the glyph's accessible name. */
  label: string;
  /** What it means, for the tooltip. */
  note: string;
}

export const HEALTH_TIERS: Record<SignalTier, HealthTierStyle> = {
  deterministic: {
    Icon: Hash,
    tone: "text-green",
    label: "counted",
    note: "Counted straight from your agent's traces. Nothing here is estimated.",
  },
  classifier: {
    Icon: Zap,
    tone: "text-ctx-memory",
    label: "classifier scored",
    note: "Scored by a small classifier that reads each search and its results. A strong estimate, shown apart from counted figures.",
  },
  judge: {
    Icon: MATCH_QUALITY_TIERS.judge.Icon,
    tone: MATCH_QUALITY_TIERS.judge.tone,
    label: MATCH_QUALITY_TIERS.judge.label,
    note: "A model read these turns and made the call. Shown apart from counted figures.",
  },
};

/** The tier glyph with its tooltip. The accessible name does not depend on the popup. */
export function TierGlyph({ tier, className }: { tier: SignalTier; className?: string }) {
  const style = HEALTH_TIERS[tier];
  const { Icon } = style;
  return (
    <Tooltip content={style.note}>
      <span
        role="img"
        aria-label={style.label}
        data-tier={tier}
        className={cn(
          "inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-md",
          style.tone,
          className,
        )}
      >
        <Icon className="size-3.5" aria-hidden strokeWidth={2.25} />
      </span>
    </Tooltip>
  );
}
