"use client";

import { X } from "lucide-react";
import Link from "next/link";
import type { PropertyBlock } from "@/lib/views/dashboards/properties";

/**
 * The small tooltip of a property that cannot be picked (RTL-396): why, and the link that fixes it
 * (the property in project settings, or the upgrade page). It shows under the dropdown that was
 * used, until the person closes it or picks something else.
 */
export function PropertyBlockNote({
  block,
  onClose,
}: {
  block: PropertyBlock;
  onClose: () => void;
}) {
  return (
    <div className="relative">
      <div
        role="status"
        className="absolute top-1 left-0 z-popover flex w-72 items-start gap-2 rounded-md border border-line bg-overlay px-2.5 py-2 text-xs text-fg shadow-overlay"
      >
        <span
          aria-hidden
          className="absolute -top-1 left-4 size-2 rotate-45 border-line border-t border-l bg-overlay"
        />
        <span className="flex flex-col gap-1">
          <span>{block.message}</span>
          <Link
            href={block.link.href}
            className="font-medium text-fg underline hover:text-fg-muted"
          >
            {block.link.label}
          </Link>
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-fg-subtle hover:text-fg"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
