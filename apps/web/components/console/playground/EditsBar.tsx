"use client";

import { Button } from "@ratel/design-system/button";
import { useCopyToClipboard } from "@ratel/design-system/use-copy-to-clipboard";
import { Check, type Copy, FileJson, GitCompare, Trash2 } from "lucide-react";
import { useState } from "react";
import { type EditedCapability, editsToDiff, editsToJson } from "@/lib/synthesis/playground/export";

/** What you can do with a set of unsaved edits, in the place that holds them. */
export function EditsBar({
  edits,
  projectSlug,
  onDiscardAll,
}: {
  edits: readonly EditedCapability[];
  projectSlug: string;
  onDiscardAll: () => void;
}) {
  const { copyStatus, copyToClipboard } = useCopyToClipboard();
  const [copiedFormat, setCopiedFormat] = useState<"diff" | "json" | null>(null);
  const confirmed = copyStatus === "copied" ? copiedFormat : null;

  if (edits.length === 0) return null;

  const context = () => ({
    projectSlug,
    generatedAt: new Date().toISOString(),
  });

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-forest-300/60 bg-coral/[0.05] px-3 py-2">
      <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-cream-dim">
        <span className="size-1.5 rounded-full bg-coral" aria-hidden />
        <strong className="font-medium text-cream">{edits.length}</strong> unsaved edit
        {edits.length === 1 ? "" : "s"}
      </span>

      <ExportButton
        icon={GitCompare}
        label="Copy diff"
        copied={confirmed === "diff"}
        title="Copy the changes as a before-and-after diff, ready to hand to a coding agent"
        onClick={() => {
          setCopiedFormat("diff");
          void copyToClipboard(editsToDiff(edits, context()));
        }}
      />
      <ExportButton
        icon={FileJson}
        label="Copy JSON"
        copied={confirmed === "json"}
        title="Copy the changes as JSON"
        onClick={() => {
          setCopiedFormat("json");
          void copyToClipboard(editsToJson(edits, context()));
        }}
      />
      <Button
        variant="ghost"
        onClick={onDiscardAll}
        title="Throw away every unsaved edit"
        className="h-auto gap-1.5 rounded-lg border-transparent px-2 py-1 text-[11px] font-normal text-warm-muted hover:border-coral/30 hover:bg-coral/10 hover:text-coral focus-visible:ring-1 focus-visible:ring-coral/50 focus-visible:ring-offset-0"
      >
        <Trash2 className="size-3" strokeWidth={1.75} aria-hidden />
        Discard all
      </Button>
    </div>
  );
}

function ExportButton({
  icon: Icon,
  label,
  copied,
  title,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  copied: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      title={title}
      className="h-auto gap-1.5 rounded-lg border-forest-300 bg-base-deep/30 px-2 py-1 text-[11px] font-normal text-cream-dim hover:bg-forest/50 hover:text-cream focus-visible:ring-1 focus-visible:ring-indigo-300/60 focus-visible:ring-offset-0"
    >
      {copied ? (
        <Check className="size-3 text-green" strokeWidth={2} aria-hidden />
      ) : (
        <Icon className="size-3" strokeWidth={1.75} aria-hidden />
      )}
      {label}
    </Button>
  );
}
