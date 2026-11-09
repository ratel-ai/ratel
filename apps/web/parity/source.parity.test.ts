import { APP_NAME } from "@/lib/platform/app-config";
import { parity } from "./ledger";
import { productName } from "./normalise";
import { SOURCE_PROBES, type SourceProbeId, sourceFacts } from "./source-probes";
import { golden, ossTree, same } from "./support";

// The items about what a page renders or what a boot hook calls: one fact each, read off the
// source by the same function on both sides (see source-probes.ts). The rendered result is what
// scripts/platform-parity/side-by-side.sh compares.

const cloud = golden<Record<SourceProbeId, unknown>>("source-facts");
const here = sourceFacts(ossTree);

/** A fact with the product's name read as one: only root metadata's title template carries it. */
const named = (fact: unknown): unknown =>
  Array.isArray(fact)
    ? fact.map((part) => (typeof part === "string" ? productName(part, APP_NAME) : part))
    : fact;

for (const id of Object.keys(SOURCE_PROBES) as SourceProbeId[]) {
  const probe = SOURCE_PROBES[id];
  parity(probe.item, probe.claim, () => {
    same(named(here[id]), named(cloud[id]));
  });
}
