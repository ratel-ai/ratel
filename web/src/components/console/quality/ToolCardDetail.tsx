import { buttonVariants } from "@ratel/design-system/button-variants";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { FilePenLine, SquarePen } from "lucide-react";
import Link from "next/link";
import type { ToolCard } from "@/lib/views/quality/descriptions";
import { percent, plural } from "@/lib/views/quality/model";

/**
 * A tool with no rewrite, opened from a link (`?tool=`): its searchable
 * description as it stands, how often searches find it in this window, and
 * Catalog's editor, where the description is changed by hand.
 */
export function ToolCardDetail({ card, windowPhrase }: { card: ToolCard; windowPhrase: string }) {
  const tally = card.tally;
  return (
    <div className="flex flex-col gap-6" data-tool-card={card.id}>
      <div
        className="flex items-start gap-3 rounded-lg border border-line px-3 py-3"
        data-state="no-rewrite"
      >
        <FilePenLine
          aria-hidden
          strokeWidth={1.5}
          className="mt-0.5 size-5 shrink-0 text-fg-faint"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-fg">No rewrite yet</p>
          <p className="text-ui text-fg-muted">
            An analysis drafts one when searches keep missing this tool.
          </p>
        </div>
      </div>

      <section className="flex flex-col gap-1.5" aria-label="Searchable description now">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-xs font-medium text-fg-subtle">Searchable description</h3>
          {card.source ? <span className="text-xs text-fg-subtle">{card.source}</span> : null}
        </div>
        {card.description ? (
          <p className="rounded-lg border border-line bg-raised px-3 py-2.5 text-sm leading-6 text-fg-muted">
            {card.description}
          </p>
        ) : (
          <p className="text-ui text-fg-subtle">Not in your catalog yet.</p>
        )}
      </section>

      {tally ? (
        <section className="flex flex-col gap-2" aria-label={`Searches in ${windowPhrase}`}>
          <h3 className="text-xs font-medium text-fg-subtle">
            Searches where it was the right tool
          </h3>
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
            <ToolStat label="Searches" value={tally.searches.toLocaleString("en-US")} />
            <ToolStat label="First" value={percent(tally.first / tally.searches)} />
            <ToolStat label="Found" value={percent(tally.found / tally.searches)} />
          </dl>
          <DotMeter
            value={tally.found / tally.searches}
            tone="success"
            label={`Found in ${tally.found} of ${plural(tally.searches, "search", "searches")} in ${windowPhrase}`}
          />
        </section>
      ) : null}

      <div className="flex justify-end border-t border-line pt-4">
        <Link
          href={card.catalogHref}
          className={buttonVariants({ variant: "primary", size: "md" })}
        >
          <SquarePen aria-hidden className="size-3.5" />
          Edit in Catalog
        </Link>
      </div>
    </div>
  );
}

function ToolStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col bg-app px-3 py-2">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="text-lg font-semibold tracking-tight text-fg tabular-nums">{value}</dd>
    </div>
  );
}
