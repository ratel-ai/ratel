import {
  ArrowRightLeft,
  BookOpen,
  BrainCircuit,
  Code2,
  type LucideIcon,
  MessageSquareText,
  Wrench,
} from "lucide-react";
import { cn } from "../cn";

/**
 * The public step kinds (RC-1067). Owned (ADR-0030): the design system imports no app code, so the
 * union is written out here; it is the same as `PublicStepKind` in the app's
 * `lib/readings/trace-signals/steps/kind.ts`.
 */
export type PublicStepKind =
  | "user_message"
  | "model_call"
  | "tool_call"
  | "skill"
  | "code"
  | "handoff";

export const STEP_KIND_ICONS: Readonly<Record<PublicStepKind, LucideIcon>> = {
  user_message: MessageSquareText,
  model_call: BrainCircuit,
  tool_call: Wrench,
  skill: BookOpen,
  code: Code2,
  handoff: ArrowRightLeft,
};

export const STEP_KIND_LABELS: Readonly<Record<PublicStepKind, string>> = {
  user_message: "User message",
  model_call: "Model call",
  tool_call: "Tool call",
  skill: "Skill",
  code: "Code",
  handoff: "Handoff",
};

/** A typed step with the same pin material as a catalog tool. */
export function StepKindPin({
  kind,
  name,
  className,
}: {
  kind: PublicStepKind;
  name: string;
  className?: string;
}) {
  const Icon = STEP_KIND_ICONS[kind];
  return (
    <span
      data-step-kind={kind}
      className={cn(
        "inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-line bg-raised px-1.5 text-xs text-fg-muted",
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0 truncate">{name}</span>
      {name !== STEP_KIND_LABELS[kind] ? (
        <span className="sr-only"> ({STEP_KIND_LABELS[kind]})</span>
      ) : null}
    </span>
  );
}
