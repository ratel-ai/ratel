"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { ToolPin } from "@ratel/design-system/entity";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { toast } from "@ratel/design-system/toast";
import { ChevronDown, FileJson, GitCompare } from "lucide-react";
import { type EditedCapability, editsToDiff, editsToJson } from "@/lib/synthesis/playground/export";

/**
 * The changes being tested, named once, with the ways out: hand them on (a
 * diff for a person or a coding agent, JSON for anything that parses), or
 * throw them away. Most changes can't be applied from Cloud: a tool's
 * description belongs to whoever runs the agent, so copying is a first-class
 * way to finish, not a fallback.
 */
export function ChangesBar({
  edits,
  projectSlug,
  onOpen,
  onDiscardAll,
}: {
  edits: readonly EditedCapability[];
  projectSlug: string;
  onOpen: (id: string) => void;
  onDiscardAll: () => void;
}) {
  if (edits.length === 0) return null;

  async function copy(format: "diff" | "json") {
    const context = { projectSlug, generatedAt: new Date().toISOString() };
    const text = format === "diff" ? editsToDiff(edits, context) : editsToJson(edits, context);
    try {
      await navigator.clipboard.writeText(text);
      toast({
        title: format === "diff" ? "Copied the changes as a diff" : "Copied the changes as JSON",
        tone: "success",
      });
    } catch {
      toast({ title: "Couldn't copy. Your browser blocked the clipboard.", tone: "danger" });
    }
  }

  const count = edits.length;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-raised px-3 py-2"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
      <p className="text-ui text-fg">
        Testing {count} unsaved change{count === 1 ? "" : "s"}
      </p>
      <span className="flex min-w-0 flex-wrap gap-1">
        {edits.slice(0, 3).map((edit) => (
          <button
            key={`${edit.kind}:${edit.id}`}
            type="button"
            onClick={() => onOpen(edit.id)}
            className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ToolPin
              name={edit.id}
              kind={edit.kind}
              className="hover:border-line-strong hover:text-fg"
            />
          </button>
        ))}
        {count > 3 ? (
          <span className="self-center text-xs text-fg-subtle">and {count - 3} more</span>
        ) : null}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Menu>
          <MenuTrigger className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            Copy changes
            <ChevronDown aria-hidden strokeWidth={1.5} className="size-3.5" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<GitCompare strokeWidth={1.5} />} onClick={() => void copy("diff")}>
              As a diff
            </MenuItem>
            <MenuItem icon={<FileJson strokeWidth={1.5} />} onClick={() => void copy("json")}>
              As JSON
            </MenuItem>
          </MenuContent>
        </Menu>
        <Button variant="ghost" size="sm" onClick={onDiscardAll}>
          Discard all
        </Button>
      </span>
    </div>
  );
}
