"use client";

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { Kbd } from "./kbd";
import { FLOATING_SURFACE } from "./popover";

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export function MenuContent({
  children,
  className,
  side = "bottom",
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-popover">
        <BaseMenu.Popup className={cn(FLOATING_SURFACE, "min-w-48 p-1", className)}>
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

const ITEM =
  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-ui text-fg outline-none select-none focus-visible:outline-none data-highlighted:bg-hover data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle";

export type MenuItemProps = BaseMenu.Item.Props & {
  icon?: ReactNode;
  shortcut?: string;
  /** Destructive actions read red and still ask for confirmation in a Dialog. */
  tone?: "default" | "danger";
};

export function MenuItem({
  icon,
  shortcut,
  tone = "default",
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cn(ITEM, tone === "danger" && "text-danger [&_svg]:text-danger", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </BaseMenu.Item>
  );
}

export type MenuLinkItemProps = BaseMenu.LinkItem.Props & {
  icon?: ReactNode;
};

/** A menu entry that navigates: a real link, so a new tab and the address work as they do anywhere. */
export function MenuLinkItem({ icon, className, children, ...props }: MenuLinkItemProps) {
  return (
    <BaseMenu.LinkItem className={cn(ITEM, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </BaseMenu.LinkItem>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}

export function MenuGroup({
  label,
  labelClassName,
  children,
}: {
  label?: string;
  labelClassName?: string;
  children: ReactNode;
}) {
  return (
    <BaseMenu.Group>
      {label ? (
        <BaseMenu.GroupLabel
          className={cn("px-2 pt-1.5 pb-1 text-xs text-fg-subtle", labelClassName)}
        >
          {label}
        </BaseMenu.GroupLabel>
      ) : null}
      {children}
    </BaseMenu.Group>
  );
}
