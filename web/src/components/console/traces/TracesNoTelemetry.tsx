import { buttonVariants } from "@ratel/design-system/button-variants";
import { EmptyState } from "@ratel/design-system/states";
import { ApiKeyCta } from "@/components/console/settings/ApiKeyCta";
import { WithApiKeyCta } from "@/components/console/settings/WithApiKeyCta";
import type { ApiKeyCta as ApiKeyCtaModel } from "@/lib/console/api-key-cta";
import { TRACES_DOCS } from "@/lib/console/docs-links";
import { emptyNoun, type TracesEmptyUnit } from "./empty-noun";

/**
 * A Traces list with nothing sent yet (DESIGN.md, Empty states). A Server
 * Component that reads the project's key itself (`WithApiKeyCta`): the page
 * passes it to the client list as its `noTelemetry` slot, and only when the
 * list is in this state. Without a key the action is "Create an API key", with
 * the docs beside it; with one it is sending the first trace, with "View API
 * keys" beside it.
 */
export function TracesNoTelemetry({
  projectId,
  unit,
  apiKey,
}: {
  projectId: string;
  unit: TracesEmptyUnit;
  /** The project's API-key CTA; read for `projectId` when absent (tests pass one). */
  apiKey?: ApiKeyCtaModel;
}) {
  if (!apiKey)
    return (
      <WithApiKeyCta projectId={projectId}>
        {(cta) => <TracesNoTelemetry projectId={projectId} unit={unit} apiKey={cta} />}
      </WithApiKeyCta>
    );
  return (
    <EmptyState
      emblem
      title={`No ${emptyNoun(unit)} yet`}
      description="Send your first trace with the SDK and it shows up here within seconds."
      action={
        <ApiKeyCta cta={apiKey} step="next" className={buttonVariants({ variant: "primary" })} />
      }
      secondary={
        apiKey.kind === "view" ? (
          <ApiKeyCta cta={apiKey} className={buttonVariants({ variant: "ghost" })} />
        ) : (
          <a
            href={TRACES_DOCS}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost" })}
          >
            Read the docs
          </a>
        )
      }
    />
  );
}
