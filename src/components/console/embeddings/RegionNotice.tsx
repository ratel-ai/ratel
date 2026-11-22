import { Callout } from "@ratel/design-system/states";

/**
 * RC-601, `cloud-embeddings-region-notice`: hosted embeddings run on a US
 * provider for now (RC-228 moves them). Plain words, no provider name: the
 * reader needs where the text goes, not which engine.
 */
export const EMBEDDINGS_REGION_TITLE = "Hosted embeddings run in the US for now";
export const EMBEDDINGS_REGION_BODY =
  "A US provider embeds the text you send, so that text leaves the EU.";
/** One short line for setup text and match hints. */
export const EMBEDDINGS_REGION_SHORT = "Runs on a US provider for now.";

/** The page's one Callout where people use hosted embeddings. */
export function EmbeddingsRegionNotice({ className }: { className?: string }) {
  return (
    <Callout tone="info" title={EMBEDDINGS_REGION_TITLE} className={className}>
      {EMBEDDINGS_REGION_BODY}
    </Callout>
  );
}
