import type { Registration } from "@/lib/contracts/registry";
import { getDb } from "@/lib/platform/db/client";
import { pruneDeadLetters } from "./store";

/** The end of a dead letter's 14 days, whatever the retention setting says (ADR-0009). */
export const ingestSpoolRegistration: Registration = {
  drainSteps: [
    {
      name: "ingest_dead_letters_prune",
      phase: "after",
      run: async () => ({ ingestDeadLettersPruned: await pruneDeadLetters(getDb()) }),
    },
  ],
};
