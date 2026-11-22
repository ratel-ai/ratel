"use client";

import { IconButton } from "@ratel/design-system/button";
import { X } from "lucide-react";
import Link from "next/link";
import { formatStamp } from "@/lib/console/settings/format";
import type { RecordedItemView } from "@/lib/views/sandboxes/page";
import { itemLabel } from "@/lib/views/sandboxes/replay";
import { traceHref } from "./types";

/**
 * The open recorded item's production reply (RC-1103, spec §4): the reference
 * a new run's output is read against. Parsed JSON shows formatted.
 */
export function RecordedOutput({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: RecordedItemView;
  onClose: () => void;
}) {
  return (
    <section aria-label="Recorded output" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Recorded output</h3>
        <IconButton label="Close the recorded item" size="icon-sm" icon={<X />} onClick={onClose} />
      </div>
      <p className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
        <span className="truncate">{itemLabel(item.input, item.spanId)}</span>
        <span aria-hidden>·</span>
        <span>{formatStamp(item.startedAt)}</span>
        <Link
          href={traceHref(projectId, item.traceId)}
          className="text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          Production trace
        </Link>
      </p>
      {item.recordedOutput === null ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-ui text-fg-muted">
          Production stored no reply for this item.
        </p>
      ) : (
        <pre
          tabIndex={0}
          className="max-h-96 overflow-auto rounded-lg border border-line bg-rail p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {typeof item.recordedOutput === "string"
            ? item.recordedOutput
            : JSON.stringify(item.recordedOutput, null, 2)}
        </pre>
      )}
    </section>
  );
}
