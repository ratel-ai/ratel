"use client";

import { cn } from "@ratel/design-system/cn";
import { NOUN_ICONS } from "@ratel/design-system/entity";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import {
  Flag,
  Info,
  type LucideIcon,
  MessageSquare,
  MoreHorizontal,
  RotateCcw,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ExampleAsk } from "@/lib/views/intents/topics-examples";
import type { FlowChipKind } from "@/lib/views/intents/topics-flow-layout";

/**
 * The marks the Intents pages draw with. The product's nouns keep their icons
 * (`NOUN_ICONS`); an ask, which the nouns list has no icon for, is one speech
 * bubble: an intent is the bubble with words in it (asks that want the same
 * thing), a conversation two bubbles.
 */
export const ASK_ICON: LucideIcon = MessageSquare;

/** An ask's icon at the size it sits beside text, like `NounIcon`. */
export function AskIcon({ className }: { className?: string }) {
  return (
    <ASK_ICON
      aria-hidden
      strokeWidth={1.5}
      className={cn("size-3.5 shrink-0 text-fg-subtle", className)}
    />
  );
}

/** Each kind of Flows chip by its mark: an intent, a task, a tool, asked again, other, and where conversations ended. */
export const FLOW_KIND_ICON: Record<FlowChipKind, LucideIcon> = {
  topic: NOUN_ICONS.intent,
  task: NOUN_ICONS.task,
  tool: NOUN_ICONS.tool,
  retry: RotateCcw,
  other: MoreHorizontal,
  ended: Flag,
  went_on: Flag,
};

/** What an example ask is, by its mark: the person's own words, or the agent's search standing in for them. */
export function ExampleSourceIcon({
  source,
  className,
}: {
  source: ExampleAsk["source"];
  className?: string;
}) {
  const Icon = source === "search" ? Search : ASK_ICON;
  return (
    <>
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={cn("size-3.5 shrink-0 text-fg-subtle", className)}
      />
      <span className="sr-only">
        {source === "search" ? "The agent's search: " : "Their words: "}
      </span>
    </>
  );
}

/**
 * An info mark: how a number is read, one hover (or tap, or Enter) away
 * (DESIGN.md: details behind a click, never a paragraph on the face). A
 * popover rather than a tooltip, so it opens on touch too.
 */
export function InfoMark({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={label}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint outline-none transition-colors duration-120",
          "hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus data-popup-open:text-fg-muted",
          className,
        )}
      >
        <Info aria-hidden strokeWidth={1.5} className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="max-w-72 min-w-0 text-xs text-fg-muted"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
