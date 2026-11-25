"use client";

import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  EllipsisVertical,
  GripVertical,
  type LucideIcon,
  MoveHorizontal,
  MoveVertical,
  X,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import type { GridStep } from "@/lib/console/grid/layout";
import type { OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

export type StepName = GridStep;

const MOVES: readonly [GridStep, string, LucideIcon][] = [
  ["up", "Move up", ArrowUp],
  ["down", "Move down", ArrowDown],
  ["left", "Move left", ArrowLeft],
  ["right", "Move right", ArrowRight],
];
const SIZES: readonly [GridStep, string, LucideIcon][] = [
  ["wider", "Wider", MoveHorizontal],
  ["narrower", "Narrower", MoveHorizontal],
  ["taller", "Taller", MoveVertical],
  ["shorter", "Shorter", MoveVertical],
];

/**
 * One widget. Quiet: its content, with a heading for a screen reader only. In edit mode it gets a
 * border, whose width is always reserved, and controls that float over its top edge, so its content
 * does not move. The content takes no press then: a drag holds it, and its links lead nowhere.
 */
export function WidgetCard({
  id,
  title,
  edit,
  children,
}: {
  id: OverviewWidgetId;
  title: string;
  /** Null in view mode. */
  edit: {
    can: (step: GridStep) => boolean;
    step: (step: GridStep) => void;
    remove: () => void;
  } | null;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-overview-widget={id}
      data-grid-surface={edit ? "" : undefined}
      className={cn(
        "relative flex h-full min-w-0 flex-col rounded-lg border bg-app",
        edit ? "border-line-strong" : "border-transparent",
      )}
    >
      <h2 id={headingId} className="sr-only">
        {title}
      </h2>
      <div
        data-grid-body=""
        inert={edit !== null}
        className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[inherit]"
      >
        {children}
      </div>
      {edit ? (
        <div
          id={toolbarId(id)}
          role="toolbar"
          aria-label={title}
          className="absolute -top-4 right-2 left-2 z-sticky flex items-center gap-1"
        >
          <span
            aria-hidden
            data-grid-handle=""
            className="flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 text-xs font-medium text-fg-muted select-none"
          >
            <GripVertical className="size-3.5 shrink-0 max-lg:hidden" />
            <span className="truncate">{title}</span>
          </span>
          <span className="ml-auto flex h-6 shrink-0 items-center rounded-md border border-line-strong bg-raised">
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={`Arrange ${title}`}
                    size="icon-sm"
                    icon={<EllipsisVertical />}
                    className="size-6 max-lg:hidden"
                  />
                }
              />
              <MenuContent align="end">
                <Steps label="Move" steps={MOVES} edit={edit} />
                <MenuSeparator />
                <Steps label="Resize" steps={SIZES} edit={edit} />
              </MenuContent>
            </Menu>
            <IconButton
              label={`Remove ${title}`}
              size="icon-sm"
              icon={<X />}
              className="relative size-6 pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
              onClick={edit.remove}
            />
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** Its first control that is shown: the menu, or Remove where there is nothing to arrange. */
export function focusToolbar(id: OverviewWidgetId) {
  const buttons = document.getElementById(toolbarId(id))?.querySelectorAll("button") ?? [];
  [...buttons].find((button) => button.offsetParent !== null)?.focus();
}

const toolbarId = (id: OverviewWidgetId) => `overview-widget-${id}-toolbar`;

function Steps({
  label,
  steps,
  edit,
}: {
  label: string;
  steps: readonly [GridStep, string, LucideIcon][];
  edit: { can: (step: GridStep) => boolean; step: (step: GridStep) => void };
}) {
  return (
    <MenuGroup label={label}>
      {steps.map(([step, words, Icon]) => (
        <MenuItem
          key={step}
          icon={<Icon />}
          disabled={!edit.can(step)}
          onClick={() => edit.step(step)}
        >
          {words}
        </MenuItem>
      ))}
    </MenuGroup>
  );
}
