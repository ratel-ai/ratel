import { cn } from "@ratel/design-system/cn";
import {
  Archive,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Link2,
  type LucideIcon,
  Repeat,
  RotateCcw,
  SearchX,
  Shuffle,
  Timer,
} from "lucide-react";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { KIND_ICONS } from "@/components/console/self-corrections/kind-marks";
import type { ExampleStatus } from "@/lib/views/tasks/examples";
import type { IssueFamily } from "@/lib/views/tasks/issues";
import type { CorrectionKind } from "@/lib/views/tasks/model";

/**
 * The marks the task pages read kinds by, one icon per kind, the same on
 * every row (DESIGN.md, "The product's nouns": every noun has an icon). The
 * nouns themselves keep theirs (`NOUN_ICONS`); these tell kinds of one noun
 * apart: a self-correction's kind, an issue's family, a fix's kind and how an
 * example run ended. Status kinds wear their status color; the rest stay gray.
 */

/**
 * Each self-correction kind, wearing the Self-corrections page's mark for
 * the same plain kind, so a retry or a switch looks the same on both pages.
 * A reply phrase reads as an apology here, as `CORRECTION_LABEL` says.
 */
export const CORRECTION_ICONS: Readonly<Record<CorrectionKind, LucideIcon>> = {
  retry_after_error: KIND_ICONS.retried,
  switch_after_error: KIND_ICONS.switched,
  gave_up_after_error: KIND_ICONS.gave_up,
  searched_again: KIND_ICONS.searched_again,
  asked_again: KIND_ICONS.asked_again,
  phrase: KIND_ICONS.apologized,
};

/** Each family of issue. */
export const ISSUE_FAMILY_ICONS: Readonly<Record<IssueFamily, LucideIcon>> = {
  failing: CircleX,
  slow: Timer,
  retry: Repeat,
  correcting: RotateCcw,
  search: SearchX,
  chain: Link2,
  confusion: Shuffle,
  unused: Archive,
  empty: CircleDashed,
  other: CircleAlert,
};

/** Each kind of fix: the Fixes page's marks, so a fix wears one icon everywhere. */
export { FIX_KIND_ICONS } from "@/components/console/fixes/kind-icons";

/**
 * An issue's mark: its kind's own, as Agent health draws it, so one issue
 * wears one icon on both pages; the family's when the kind has none.
 */
export function issueIcon(issue: { kind: string; family: IssueFamily }): LucideIcon {
  return (
    (SIGNAL_KIND_ICONS as Readonly<Partial<Record<string, LucideIcon>>>)[issue.kind] ??
    ISSUE_FAMILY_ICONS[issue.family]
  );
}

/** How an example run ended: a status, so it wears the status colors with its word. */
export const EXAMPLE_STATUS_ICONS: Readonly<
  Record<ExampleStatus, { icon: LucideIcon; tone: string }>
> = {
  worked: { icon: CircleCheck, tone: "text-success" },
  recovered: { icon: RotateCcw, tone: "text-warning" },
  gave_up: { icon: Ban, tone: "text-danger" },
  failed: { icon: CircleX, tone: "text-danger" },
};

/** One kind's icon at the size it sits beside text: 14 px, stroke 1.5. */
export function KindIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <Icon
      aria-hidden
      strokeWidth={1.5}
      className={cn("size-3.5 shrink-0 text-fg-subtle", className)}
    />
  );
}
