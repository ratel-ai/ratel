import type { ToolCorpusPort } from "@/lib/contracts/tool-corpus";
import { loadToolCorpus, type ServiceDb } from "@/lib/synthesis/match-quality/service";

/** The core's tool corpus, lent to the edition at startup (`instrumentation.node.ts`). */
export function createToolCorpus(db?: ServiceDb): ToolCorpusPort {
  return { load: (projectId) => loadToolCorpus(projectId, db) };
}
