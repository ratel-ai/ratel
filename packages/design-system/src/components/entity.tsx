import {
  BookOpen,
  CircleAlert,
  Hammer,
  ListChecks,
  type LucideIcon,
  MessageSquareText,
  MessagesSquare,
  RotateCcw,
  Waypoints,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { TASK_COLOR_CLASSES, type TaskColorSlot } from "./task-colors";

/**
 * The product's nouns as marks (DESIGN.md, "The product's nouns"): one icon per noun, the same
 * everywhere, so a reader learns them once and recognises them on every page without reading a
 * label. Pins give each thing an identity instead of plain text: a tool is a mono pin with a
 * wrench, a task a pin with its color, an intent a pin with a speech mark.
 *
 * PRIVACY: names go in text, never in attributes. Intent names are written from people's asks;
 * a pin that links carries only its href.
 */
export const NOUN_ICONS = {
  intent: MessageSquareText,
  conversation: MessagesSquare,
  flow: Waypoints,
  task: ListChecks,
  tool: Wrench,
  skill: BookOpen,
  issue: CircleAlert,
  selfCorrection: RotateCcw,
  fix: Hammer,
} as const satisfies Record<string, LucideIcon>;

export type Noun = keyof typeof NOUN_ICONS;

/** A noun's icon at the size it sits beside text: 14 px, stroke 1.5. */
export function NounIcon({ noun, className }: { noun: Noun; className?: string }) {
  const Icon = NOUN_ICONS[noun];
  return (
    <Icon
      aria-hidden
      strokeWidth={1.5}
      className={cn("size-3.5 shrink-0 text-fg-subtle", className)}
    />
  );
}

const PIN =
  "inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-line bg-raised px-1.5 text-xs text-fg-muted";
const PIN_LINK =
  "outline-none transition-colors duration-120 hover:border-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

function Pin({
  href,
  mark,
  children,
  className,
}: {
  href?: string;
  mark: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      {mark}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cn(PIN, PIN_LINK, className)}>
      {body}
    </Link>
  ) : (
    <span className={cn(PIN, className)}>{body}</span>
  );
}

/** A tool (or a skill) by its catalog id, in mono. Dashed when the catalog no longer has it. */
export function ToolPin({
  name,
  kind = "tool",
  href,
  missing = false,
  className,
}: {
  name: string;
  kind?: "tool" | "skill";
  href?: string;
  missing?: boolean;
  className?: string;
}) {
  return (
    <Pin
      href={href}
      mark={<NounIcon noun={kind} className="size-3" />}
      className={cn("font-mono", missing && "border-dashed", className)}
    >
      {name}
    </Pin>
  );
}

/** A task by name, with its color (`task-colors.ts`): the color is the identity, the name stays in text tokens. */
export function TaskPin({
  name,
  slot,
  href,
  className,
}: {
  name: string;
  slot: TaskColorSlot | null;
  href?: string;
  className?: string;
}) {
  return (
    <Pin
      href={href}
      mark={
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-[2px]", TASK_COLOR_CLASSES[slot ?? "neutral"].bg)}
        />
      }
      className={className}
    >
      {name}
    </Pin>
  );
}

/** An intent (what people want) by name. */
export function IntentPin({
  name,
  href,
  className,
}: {
  name: string;
  href?: string;
  className?: string;
}) {
  return (
    <Pin href={href} mark={<NounIcon noun="intent" className="size-3" />} className={className}>
      {name}
    </Pin>
  );
}
