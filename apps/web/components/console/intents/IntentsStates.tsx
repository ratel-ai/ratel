import { Callout, EmptyState } from "@ratel/design-system/states";
import { RefreshWhileBuilding } from "@/components/console/health/RefreshWhileBuilding";
import { MapLoader } from "@/components/console/intent-map/MapLoader";
import { type ReadingRequest, ReadNow } from "@/components/console/intents/ReadNow";

/**
 * The Intents pages before there is anything to show, in the place the data
 * would be (DESIGN.md, Empty states): what fills the page and how to start it
 * now; while a reading runs, the loader and a page that reads itself again.
 */

const FRAME = "rounded-lg border border-line dot-grid-fade";

/** No reading yet. */
export function IntentsNoReading({
  inFlight,
  request,
}: {
  inFlight: boolean;
  request: ReadingRequest;
}) {
  if (inFlight) {
    return (
      <section
        aria-label="Reading intents"
        className={`${FRAME} flex flex-col items-center gap-3 px-6 py-12 text-center`}
      >
        <span className="flex h-10 items-center">
          <MapLoader label="Reading what people ask" />
        </span>
        <p className="text-sm font-semibold text-fg">Reading what people ask</p>
        <p className="max-w-sm text-sm text-fg-muted">
          Intents fill in here when it finishes, usually within a minute.
        </p>
        <RefreshWhileBuilding />
      </section>
    );
  }
  return (
    <section aria-label="No intents yet" className={FRAME}>
      <EmptyState
        emblem
        title="No intents yet"
        description="Intents group what people ask over the last 30 days. They fill in after each Agent health reading."
        action={<ReadNow request={request} />}
      />
    </section>
  );
}

/** A reading found nothing to group: no turns, or no text to read in them. */
export function IntentsNothingToGroup({
  turns,
  request,
}: {
  turns: number;
  request: ReadingRequest;
}) {
  return (
    <section aria-label="No asks to group" className={FRAME}>
      <EmptyState
        emblem
        title="No asks to group yet"
        description={
          turns === 0
            ? "No asks in the last 30 days. Intents appear once your agent's runs arrive."
            : "None of the last 30 days' asks carried words to read. Send people's messages (content capture) and intents appear."
        }
        action={<ReadNow request={request} variant="secondary" label="Read again" />}
      />
    </section>
  );
}

/** The reading could not be loaded; the rest of the page still works. */
export function IntentsReadFailed() {
  return (
    <Callout tone="warning" title="Couldn't load intents">
      Try again in a moment.
    </Callout>
  );
}
