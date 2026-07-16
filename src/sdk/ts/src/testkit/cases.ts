import type { RatelAdapter, SearchCapabilitiesResult } from "../index.js";

/** The six behavioural areas the conformance battery partitions its cases into. */
export type ConformanceArea =
  | "ingest-expose"
  | "reserved-ids"
  | "recall-topk"
  | "passthrough"
  | "recall-pair"
  | "guards";

/**
 * How a conformance case asks the framework hooks to build a tool: a
 * description retrieval can rank on, and (for executables) a result the case can
 * observe come back through the framework's executor.
 */
export interface ConformanceToolSpec {
  /** The tool's description — make it query-matchable; retrieval ranks on it. */
  description: string;
  /** What the built tool's executor returns; the reference builder defaults to `{ ok: true }`. */
  result?: unknown;
}

/**
 * What the testkit computes for the framework's {@link
 * AdapterConformanceOptions.validateRecallPair} hook to check the adapted
 * recall pair against: the deterministic call id, the query, and the canonical
 * recall the core produced (via the pure `core.recall(query)`).
 */
export interface RecallExpectation {
  /** The id the pair must carry — deterministic per fresh core (`recall_0`, then `recall_1`). */
  callId: string;
  /** The recall query the call message must encode. */
  query: string;
  /** The canonical result the result message must carry, from the core's pure recall. */
  recall: SearchCapabilitiesResult;
}

/**
 * The framework-supplied surface the conformance battery drives an adapter
 * through. Only the codecs live on the {@link RatelAdapter}; these hooks teach
 * the testkit how to *build* the framework's tools and *read back* its exposed
 * tools and recall messages, so every case can run without the real framework.
 *
 * @typeParam TTool - The framework's tool type (the adapter's `TTool`).
 * @typeParam TMessage - The framework's message type (the adapter's `TMessage`).
 */
export interface AdapterConformanceOptions<TTool, TMessage> {
  /** Fresh adapter under test — called once per case, so cases never share state. */
  adapter(): RatelAdapter<TTool, TMessage>;
  /** Build a framework tool that ingests as an executable (its executor returns `spec.result`). */
  makeExecutableTool(spec: ConformanceToolSpec): TTool;
  /**
   * Build a framework tool that ingests as a passthrough (no executor). Absent
   * when the framework has no provider-executed tool shape — the passthrough
   * cases are then emitted as skipped rather than failing.
   */
  makePassthroughTool?(spec: ConformanceToolSpec): TTool;
  /** Invoke an exposed framework tool with an args object and return its result. */
  callExposedTool(tool: TTool, args: Record<string, unknown>): Promise<unknown> | unknown;
  /** Assert the adapted recall messages encode {@link RecallExpectation}; throw on mismatch. */
  validateRecallPair(messages: TMessage[], expected: RecallExpectation): void;
  /** Extra framework-shape strictness on an exposed tool (e.g. it went through the codec); throw on mismatch. */
  validateExposedTool?(tool: TTool): void;
}

/**
 * One conformance case: a named, self-contained check that builds its own fresh
 * `ratel()` core and adapted view and asserts one facet of the SPI contract.
 * `run()` throws (via `node:assert`) on failure; a case with `skipped` set can't
 * run because a required optional hook is absent.
 */
export interface ConformanceCase {
  /** Unique, human-readable case name. */
  name: string;
  /** The area this case belongs to. */
  area: ConformanceArea;
  /** When set, why the case can't run (a required optional hook is missing). */
  skipped?: string;
  /** Execute the case; rejects on failure. A no-op when {@link ConformanceCase.skipped} is set. */
  run(): Promise<void>;
}

/** Skip reason emitted for the passthrough cases when no `makePassthroughTool` hook is supplied. */
const NO_PASSTHROUGH_HOOK = "adapter did not supply makePassthroughTool";

/**
 * Build the full adapter conformance battery for a set of framework hooks — the
 * named cases every Ratel framework adapter must pass. Each case is independent
 * and builds its own fresh core, so they can run in any order or in isolation.
 * When {@link AdapterConformanceOptions.makePassthroughTool} is absent, the
 * passthrough cases come back marked `skipped`.
 *
 * @param options - The framework's adapter factory and tool/message hooks.
 * @returns The battery as a flat list of {@link ConformanceCase}s.
 */
export function adapterConformanceCases<TTool, TMessage>(
  options: AdapterConformanceOptions<TTool, TMessage>,
): ConformanceCase[] {
  const passthroughSkip = options.makePassthroughTool ? undefined : NO_PASSTHROUGH_HOOK;
  return [
    {
      name: "registers an ingested tool into the shared catalog",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "invokes an ingested tool through the framework executor",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "exposes exactly the three capability tools, fresh each call",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "runs discovery and invocation through the framework shape",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "loads skill content through the framework shape",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "discovers tools registered after expose()",
      area: "ingest-expose",
      run: async () => {},
    },
    {
      name: "rejects the reserved capability ids and leaves the catalog clean",
      area: "reserved-ids",
      run: async () => {},
    },
    {
      name: "caps recall topK at 50",
      area: "recall-topk",
      run: async () => {},
    },
    {
      name: "falls back to the default topK on an invalid value",
      area: "recall-topk",
      run: async () => {},
    },
    {
      name: "exposes a passthrough by identity and never catalogs it",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {},
    },
    {
      name: "keeps passthroughs per view",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {},
    },
    {
      name: "first registration wins across executables and passthroughs",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {},
    },
    {
      name: "needs a re-expose to surface a late passthrough",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {},
    },
    {
      name: "returns the adapter's pair with call id recall_0",
      area: "recall-pair",
      run: async () => {},
    },
    {
      name: "returns [] and spends no id when nothing matches",
      area: "recall-pair",
      run: async () => {},
    },
    {
      name: "mints monotonic ids shared across views",
      area: "recall-pair",
      run: async () => {},
    },
    {
      name: "builds the pair for a skills-only match",
      area: "recall-pair",
      run: async () => {},
    },
    {
      name: "does not re-run ingest on a duplicate id",
      area: "guards",
      run: async () => {},
    },
    {
      name: "skips ingest for an id already registered natively",
      area: "guards",
      run: async () => {},
    },
    {
      name: "keeps the base surface intact under extend",
      area: "guards",
      run: async () => {},
    },
    {
      name: "requires a non-empty adapter name",
      area: "guards",
      run: async () => {},
    },
  ];
}
