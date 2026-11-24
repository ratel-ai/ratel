"use client";

import { IconButton } from "@ratel/design-system/button";
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
  ArrowUpRight,
  EllipsisVertical,
  EyeOff,
  type LucideIcon,
  MoveHorizontal,
  MoveVertical,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import type { GridStep } from "@/lib/console/grid/layout";
import type { OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

export type StepName = GridStep;

export const menuId = (id: OverviewWidgetId) => `overview-widget-${id}-menu`;

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

/** One widget: its header (which a drag holds), then a body that fills the rest of the card. */
export function WidgetCard({
  id,
  title,
  link,
  edit,
  children,
}: {
  id: OverviewWidgetId;
  title: string;
  link: { href: string; label: string } | null;
  /** Null where nobody may change the layout. */
  edit: {
    can: (step: GridStep) => boolean;
    step: (step: GridStep) => void;
    hide: () => void;
  } | null;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-overview-widget={id}
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-raised"
    >
      <header
        data-grid-handle={edit ? "" : undefined}
        className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-4"
      >
        <h2 id={headingId} className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {title}
        </h2>
        {link ? (
          <Link
            href={link.href}
            aria-label={link.label}
            title={link.label}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ArrowUpRight aria-hidden strokeWidth={1.5} className="size-4" />
          </Link>
        ) : null}
        {edit ? (
          <Menu>
            <MenuTrigger
              id={menuId(id)}
              render={
                <IconButton label={`Arrange ${title}`} size="icon-sm" icon={<EllipsisVertical />} />
              }
            />
            <MenuContent align="end">
              <div className="max-lg:hidden">
                <Steps label="Move" steps={MOVES} edit={edit} />
                <MenuSeparator />
                <Steps label="Resize" steps={SIZES} edit={edit} />
                <MenuSeparator />
              </div>
              <MenuItem icon={<EyeOff />} onClick={edit.hide}>
                Hide
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </header>
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

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
