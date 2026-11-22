import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Lock } from "lucide-react";
import Link from "next/link";
import { RetryButton } from "./RetryButton";

/**
 * The states every Quality tab shares (DESIGN.md, Every state is designed):
 * not on the plan, a read that failed, and no database at all.
 */

/** Match quality is a Pro feature; this sits where the list would be. */
export function UpgradeState({ billingHref }: { billingHref: string | null }) {
  return (
    <div className="rounded-lg border border-line" data-state="upgrade">
      <EmptyState
        icon={Lock}
        title="Misses and rewrites are part of Pro"
        description="See which searches missed the right tool, and get rewrites that fix them."
        action={
          billingHref ? (
            <Link href={billingHref} className={buttonVariants({ variant: "primary", size: "md" })}>
              Upgrade to Pro
            </Link>
          ) : (
            <span className="text-sm text-fg-muted">Ask your Ratel contact to turn on Pro.</span>
          )
        }
      />
    </div>
  );
}

/** A section that could not be read says so in place; the rest of the page still works. */
export function LoadFailed({ what }: { what: string }) {
  return (
    <Callout tone="danger" title={`Couldn't load ${what}`} action={<RetryButton />}>
      Try again in a moment.
    </Callout>
  );
}

export function QualityUnavailable() {
  return (
    <Page>
      <PageHeader title="Quality" />
      <PageBody>
        <Callout title="No database connected yet">
          Quality becomes available once setup finishes.
        </Callout>
      </PageBody>
    </Page>
  );
}
