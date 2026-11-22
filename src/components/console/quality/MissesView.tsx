import { buttonVariants } from "@ratel/design-system/button-variants";
import { EmptyState } from "@ratel/design-system/states";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { QualityEvidence } from "@/lib/views/quality/load-misses";
import type { MissRow } from "@/lib/views/quality/miss-rows";
import { plural } from "@/lib/views/quality/model";
import { MissesList } from "./MissesList";
import { LoadFailed, UpgradeState } from "./states";

/**
 * The Misses tab: every search whose right tool was not ranked first. Each
 * state sits where the list would be, so the header above keeps working.
 */
export function MissesView({
  projectId,
  evidence,
  rows,
  locked,
  billingHref,
  windowPhrase,
  wider,
  analyse,
  now,
}: {
  projectId: string;
  /** Null when the read failed. */
  evidence: QualityEvidence | null;
  /** The listed misses, built for this tab only. */
  rows: readonly MissRow[];
  /** The plan does not include match quality. */
  locked: boolean;
  billingHref: string | null;
  /** "the last 7 days". */
  windowPhrase: string;
  /** A longer window to try when this one is empty; null when already long. */
  wider: { href: string; label: string } | null;
  /** The run menu, offered where an analysis would produce answers. */
  analyse?: ReactNode;
  now: Date;
}) {
  if (locked) return <UpgradeState billingHref={billingHref} />;
  if (evidence === null) return <LoadFailed what="misses" />;

  if (evidence.searches === 0) {
    return (
      <Frame>
        <EmptyState
          emblem
          title={`No searches in ${windowPhrase}`}
          description="Misses show up here once your agent searches through Ratel with query text recorded."
          action={
            wider ? (
              <Link
                href={wider.href}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                {wider.label}
              </Link>
            ) : null
          }
        />
      </Frame>
    );
  }
  if (evidence.answered === 0) {
    return (
      <Frame>
        <EmptyState
          emblem
          title="No search has a known right tool yet"
          description={`An analysis decides which tool each of your ${plural(evidence.searches, "search", "searches")} needed.`}
          action={analyse}
        />
      </Frame>
    );
  }
  if (evidence.missCount === 0) {
    return (
      <Frame>
        <EmptyState
          icon={CircleCheck}
          title="The right tool came first every time"
          description={`Across ${plural(evidence.answered, "search", "searches")} with a known right tool in ${windowPhrase}.`}
        />
      </Frame>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-tab="misses">
      <MissesList
        projectId={projectId}
        rows={rows}
        total={evidence.missCount}
        now={now.toISOString()}
      />
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line" data-tab="misses">
      {children}
    </div>
  );
}
