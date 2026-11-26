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
import { type KeyboardEvent, type ReactNode, useId } from "react";
import type { GridStep } from "@/lib/console/grid/layout";

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

/** The arrow keys on the corner handle: its corner goes where the arrow points. */
const RESIZE_KEYS: Readonly<Record<string, GridStep>> = {
  ArrowRight: "wider",
  ArrowLeft: "narrower",
  ArrowDown: "taller",
  ArrowUp: "shorter",
};

/** The card whose resize handle took the last step: the focus goes back there, not to the toolbar. */
let resizedFrom: string | null = null;

export interface CardEdit {
  can: (step: GridStep) => boolean;
  step: (step: GridStep) => void;
  remove: () => void;
  /** Menu items of the page's own, above the steps. */
  items?: ReactNode;
}

/**
 * One card. Quiet: its content, with a heading for a screen reader only, or a title row where the
 * content does not say what it is. In edit mode it gets a border, whose width is always reserved,
 * and controls that float over its top edge, so its content does not move. The content takes no
 * press then: a drag holds it, and its links lead nowhere.
 */
export function CardFrame({
  id,
  title,
  titleRow,
  edit,
  children,
}: {
  id: string;
  title: string;
  /** Draws the title, with this after it. Such a card has padding, and its content may reach out of it. */
  titleRow?: ReactNode;
  /** Null in view mode. */
  edit: CardEdit | null;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-card={id}
      data-grid-surface={edit ? "" : undefined}
      className={cn(
        "relative flex h-full min-w-0 flex-col rounded-lg border bg-app",
        edit ? "border-line-strong" : "border-transparent",
      )}
    >
      {titleRow === undefined ? (
        <h2 id={headingId} className="sr-only">
          {title}
        </h2>
      ) : null}
      <div
        data-grid-body=""
        inert={edit !== null}
        className={cn(
          "@container flex min-h-0 min-w-0 flex-1 flex-col rounded-[inherit]",
          titleRow === undefined ? "overflow-hidden" : "gap-3 p-4",
        )}
      >
        {titleRow === undefined ? (
          children
        ) : (
          <>
            <div className="flex min-h-7 items-center gap-2">
              <h2
                id={headingId}
                title={title}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-fg"
              >
                {title}
              </h2>
              {titleRow}
            </div>
            {children}
          </>
        )}
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
                {edit.items ? (
                  <>
                    {edit.items}
                    <MenuSeparator />
                  </>
                ) : null}
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
      {edit ? <ResizeHandle id={id} title={title} edit={edit} /> : null}
    </section>
  );
}

/**
 * The corner mark, always shown in edit mode, and the keyboard's way to resize: it takes the focus,
 * and an arrow key is one step. A pointer resizes by the grid's own handle over it (`card-grid.css`),
 * which is 44 px on touch. Below `lg` the cards are one column and do not resize.
 */
function ResizeHandle({ id, title, edit }: { id: string; title: string; edit: CardEdit }) {
  function onKeyDown(event: KeyboardEvent) {
    const step = RESIZE_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    if (!edit.can(step)) return;
    resizedFrom = id;
    edit.step(step);
  }
  return (
    <button
      type="button"
      id={resizeId(id)}
      data-grid-resize=""
      aria-label={`Resize ${title}`}
      aria-keyshortcuts="ArrowRight ArrowLeft ArrowDown ArrowUp"
      title="Resize: arrow keys"
      onKeyDown={onKeyDown}
      className="absolute right-0 bottom-0 size-6 rounded-br-lg rounded-tl-md outline-none after:absolute after:right-[5px] after:bottom-[5px] after:size-[7px] after:rounded-br-[3px] after:border-r-2 after:border-b-2 after:border-fg-subtle after:content-[''] focus-visible:ring-2 focus-visible:ring-focus max-lg:hidden"
    />
  );
}

/**
 * Its first control that is shown: the menu, or Remove where there is nothing to arrange. After a
 * step from the resize handle, the handle again.
 */
export function focusToolbar(id: string) {
  if (resizedFrom === id) {
    resizedFrom = null;
    document.getElementById(resizeId(id))?.focus();
    return;
  }
  const buttons = document.getElementById(toolbarId(id))?.querySelectorAll("button") ?? [];
  [...buttons].find((button) => button.offsetParent !== null)?.focus();
}

const toolbarId = (id: string) => `card-${id}-toolbar`;
const resizeId = (id: string) => `card-${id}-resize`;

function Steps({
  label,
  steps,
  edit,
}: {
  label: string;
  steps: readonly [GridStep, string, LucideIcon][];
  edit: CardEdit;
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
