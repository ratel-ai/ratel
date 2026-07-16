import assert from "node:assert/strict";
import {
  type ExecutableTool,
  GET_SKILL_CONTENT_ID,
  INVOKE_TOOL_ID,
  ratel,
  type RatelAdapter,
  SEARCH_CAPABILITIES_ID,
  type SearchCapabilitiesResult,
  SkillCatalog,
} from "../index.js";

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

/** The three reserved capability-tool ids the exposed set must be exactly. */
const CAPABILITY_IDS = [SEARCH_CAPABILITIES_ID, INVOKE_TOOL_ID, GET_SKILL_CONTENT_ID];

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
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        view.tools.register({
          read_file: options.makeExecutableTool({ description: "Read a file from local disk." }),
        });
        assert.ok(core.tools.has("read_file"), "the core sees the ingested tool");
        assert.ok(view.tools.catalog.has("read_file"), "it landed in the shared catalog");
        assert.ok(view.tools.has("read_file"), "the adapted view knows it");
      },
    },
    {
      name: "invokes an ingested tool through the framework executor",
      area: "ingest-expose",
      run: async () => {
        const marker = { invoked: "read_file" };
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        view.tools.register({
          read_file: options.makeExecutableTool({ description: "Read a file.", result: marker }),
        });
        const result = await core.tools.invoke("read_file", {});
        assert.deepStrictEqual(result, marker, "catalog invoke ran the framework executor");
      },
    },
    {
      name: "exposes exactly the three capability tools, fresh each call",
      area: "ingest-expose",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        view.tools.register({
          read_file: options.makeExecutableTool({ description: "Read a file." }),
        });
        const exposed = view.expose();
        assert.deepStrictEqual(
          Object.keys(exposed).sort(),
          [...CAPABILITY_IDS].sort(),
          "exposes exactly the three capability tools",
        );
        const again = view.expose();
        assert.notStrictEqual(
          again[SEARCH_CAPABILITIES_ID],
          exposed[SEARCH_CAPABILITIES_ID],
          "expose() builds fresh objects each call",
        );
        for (const id of CAPABILITY_IDS) {
          options.validateExposedTool?.(exposed[id]);
        }
      },
    },
    {
      name: "runs discovery and invocation through the framework shape",
      area: "ingest-expose",
      run: async () => {
        const marker = { ran: true };
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        // A neutral id, so discovery ranks on the ingested description (the
        // codec's output) rather than on query terms leaking through the id.
        view.tools.register({
          provisioner: options.makeExecutableTool({
            description: "Deploy the app to production servers.",
            result: marker,
          }),
        });
        const exposed = view.expose();
        const search = (await options.callExposedTool(exposed[SEARCH_CAPABILITIES_ID], {
          query: "deploy to production",
        })) as SearchCapabilitiesResult;
        assert.strictEqual(
          search.tools.groups[0]?.hits[0]?.toolId,
          "provisioner",
          "search_capabilities finds the ingested tool through the framework shape",
        );
        const invoked = await options.callExposedTool(exposed[INVOKE_TOOL_ID], {
          toolId: "provisioner",
          args: {},
        });
        assert.deepStrictEqual(
          invoked,
          marker,
          "invoke_tool runs the ingested tool through the framework shape",
        );
      },
    },
    {
      name: "loads skill content through the framework shape",
      area: "ingest-expose",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        await view.skills.register({
          id: "deploy",
          name: "deploy",
          description: "Deploy playbook: preview vs production, rollbacks.",
          tags: [],
          body: "# Deploy",
        });
        const exposed = view.expose();
        const loaded = (await options.callExposedTool(exposed[GET_SKILL_CONTENT_ID], {
          skillId: "deploy",
        })) as { body?: string };
        assert.strictEqual(
          loaded.body,
          "# Deploy",
          "get_skill_content loads the skill body through the framework shape",
        );
      },
    },
    {
      name: "discovers tools registered after expose()",
      area: "ingest-expose",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        const exposed = view.expose(); // take the set first…
        view.tools.register({
          late_tool: options.makeExecutableTool({ description: "Deploy the app to production." }),
        }); // …register later
        const search = (await options.callExposedTool(exposed[SEARCH_CAPABILITIES_ID], {
          query: "deploy production",
        })) as SearchCapabilitiesResult;
        assert.strictEqual(
          search.tools.groups[0]?.hits[0]?.toolId,
          "late_tool",
          "a tool registered after expose() is still discoverable",
        );
      },
    },
    {
      name: "rejects the reserved capability ids and leaves the catalog clean",
      area: "reserved-ids",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        for (const id of CAPABILITY_IDS) {
          assert.throws(
            () => view.tools.register({ [id]: options.makeExecutableTool({ description: "impostor" }) }),
            /reserved/,
            `registering ${id} throws`,
          );
          assert.ok(!view.tools.catalog.has(id), `${id} never entered the catalog`);
        }
        view.tools.register({
          read_file: options.makeExecutableTool({ description: "Read a file." }),
        });
        assert.ok(view.tools.catalog.has("read_file"), "a normal registration still works");
      },
    },
    {
      name: "caps recall topK at 50",
      area: "recall-topk",
      run: async () => {
        const core = ratel({ recallTopK: 999 });
        const view = core.adaptTo(options.adapter());
        view.tools.register(manyGrepTools(options));
        const expected = await core.recall("search files grep");
        assert.ok(expected, "the core recall matched");
        const count = countHits(expected);
        assert.ok(count <= 50, `topK is capped at 50 (got ${count})`);
        assert.ok(count > 5, "999 is honoured past the default before the cap");
        const messages = await view.recall("search files grep");
        options.validateRecallPair(messages, {
          callId: "recall_0",
          query: "search files grep",
          recall: expected,
        });
      },
    },
    {
      name: "falls back to the default topK on an invalid value",
      area: "recall-topk",
      run: async () => {
        const core = ratel({ recallTopK: -1 });
        const view = core.adaptTo(options.adapter());
        view.tools.register(manyGrepTools(options));
        const expected = await core.recall("search files grep");
        assert.ok(expected, "the core recall matched");
        assert.ok(countHits(expected) <= 5, "an invalid topK falls back to the default 5");
        const messages = await view.recall("search files grep");
        options.validateRecallPair(messages, {
          callId: "recall_0",
          query: "search files grep",
          recall: expected,
        });
      },
    },
    {
      name: "exposes a passthrough by identity and never catalogs it",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {
        const makePassthrough = options.makePassthroughTool;
        if (!makePassthrough) return;
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        const provider = makePassthrough({ description: "provider-run search" });
        view.tools.register({ provider_search: provider });
        assert.strictEqual(
          view.expose().provider_search,
          provider,
          "the passthrough is exposed by identity, untouched",
        );
        assert.ok(!view.tools.catalog.has("provider_search"), "it never enters the catalog");
        assert.ok(view.tools.has("provider_search"), "but the view knows it");
      },
    },
    {
      name: "keeps passthroughs per view",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {
        const makePassthrough = options.makePassthroughTool;
        if (!makePassthrough) return;
        const core = ratel();
        const a = core.adaptTo(options.adapter());
        const b = core.adaptTo(options.adapter());
        const provider = makePassthrough({ description: "provider-run search" });
        a.tools.register({ provider_search: provider });
        assert.strictEqual(a.expose().provider_search, provider, "view a exposes it");
        assert.ok(!("provider_search" in b.expose()), "view b does not — passthroughs are per view");
      },
    },
    {
      name: "first registration wins across executables and passthroughs",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {
        const makePassthrough = options.makePassthroughTool;
        if (!makePassthrough) return;
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        // A passthrough claims its id: a later executable must not shadow it.
        const provider = makePassthrough({ description: "provider-run" });
        view.tools.register({ claimed: provider });
        view.tools.register({ claimed: options.makeExecutableTool({ description: "late executable" }) });
        assert.ok(!view.tools.catalog.has("claimed"), "the executable did not shadow the passthrough");
        assert.strictEqual(view.expose().claimed, provider, "the first passthrough still owns the id");
        // The reverse: an executable claims its id, a later passthrough must not shadow it.
        view.tools.register({ dup: options.makeExecutableTool({ description: "first description" }) });
        view.tools.register({ dup: makePassthrough({ description: "late passthrough" }) });
        assert.ok(view.tools.catalog.has("dup"), "the executable kept its id");
        assert.ok(!("dup" in view.expose()), "the late passthrough is not exposed");
      },
    },
    {
      name: "needs a re-expose to surface a late passthrough",
      area: "passthrough",
      skipped: passthroughSkip,
      run: async () => {
        const makePassthrough = options.makePassthroughTool;
        if (!makePassthrough) return;
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        const early = view.expose(); // taken before the passthrough exists
        const provider = makePassthrough({ description: "provider-run late" });
        view.tools.register({ late_provider: provider });
        assert.ok(!("late_provider" in early), "the already-taken set does not include it");
        assert.strictEqual(view.expose().late_provider, provider, "a re-expose surfaces it");
      },
    },
    {
      name: "returns the adapter's pair with call id recall_0",
      area: "recall-pair",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        view.tools.register({
          deploy_app: options.makeExecutableTool({
            description: "Deploy the app to production servers.",
          }),
        });
        const expected = await core.recall("deploy to production");
        assert.ok(expected, "the core recall matched");
        const messages = await view.recall("deploy to production");
        options.validateRecallPair(messages, {
          callId: "recall_0",
          query: "deploy to production",
          recall: expected,
        });
      },
    },
    {
      name: "returns [] and spends no id when nothing matches",
      area: "recall-pair",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        assert.deepStrictEqual(await view.recall("anything at all"), [], "empty catalog → []");
        view.tools.register({
          deploy_app: options.makeExecutableTool({ description: "Deploy the app to production." }),
        });
        assert.deepStrictEqual(
          await view.recall("zzzqqq totally unrelated"),
          [],
          "a query with no hits → []",
        );
        // Neither empty recall spent a call id, so the first real hit is still recall_0.
        const expected = await core.recall("deploy production");
        assert.ok(expected, "the core recall matched");
        const messages = await view.recall("deploy production");
        options.validateRecallPair(messages, {
          callId: "recall_0",
          query: "deploy production",
          recall: expected,
        });
      },
    },
    {
      name: "mints monotonic ids shared across views",
      area: "recall-pair",
      run: async () => {
        const core = ratel();
        const a = core.adaptTo(options.adapter());
        const b = core.adaptTo(options.adapter());
        a.tools.register({
          shared_tool: options.makeExecutableTool({ description: "Shared search grep tool." }),
        });
        const expected = await core.recall("shared grep");
        assert.ok(expected, "the core recall matched");
        const first = await a.recall("shared grep");
        options.validateRecallPair(first, { callId: "recall_0", query: "shared grep", recall: expected });
        const second = await b.recall("shared grep");
        options.validateRecallPair(second, {
          callId: "recall_1",
          query: "shared grep",
          recall: expected,
        });
      },
    },
    {
      name: "builds the pair for a skills-only match",
      area: "recall-pair",
      run: async () => {
        const core = ratel();
        const view = core.adaptTo(options.adapter());
        await view.skills.register({
          id: "vercel-deploy",
          name: "vercel-deploy",
          description: "Deploy to Vercel: env vars, preview vs production, rollbacks.",
          tags: ["vercel"],
          body: "# Vercel",
        });
        const expected = await core.recall("deploy to vercel");
        assert.ok(expected, "a skills-only match still produces a recall");
        assert.deepStrictEqual(expected.tools.groups, [], "there are no tool hits");
        assert.ok(
          expected.skills.some((s) => s.skillId === "vercel-deploy"),
          "the skill matched",
        );
        const messages = await view.recall("deploy to vercel");
        options.validateRecallPair(messages, {
          callId: "recall_0",
          query: "deploy to vercel",
          recall: expected,
        });
      },
    },
    {
      name: "does not re-run ingest on a duplicate id",
      area: "guards",
      run: async () => {
        let ingestCalls = 0;
        const adapter = options.adapter();
        const counting: RatelAdapter<TTool, TMessage> = {
          ...adapter,
          ingest(id, tool) {
            ingestCalls++;
            return adapter.ingest(id, tool);
          },
        };
        const view = ratel().adaptTo(counting);
        view.tools.register({ fresh: options.makeExecutableTool({ description: "Fresh tool." }) });
        view.tools.register({ fresh: options.makeExecutableTool({ description: "Duplicate call." }) });
        assert.strictEqual(ingestCalls, 1, "ingest ran once despite the repeated register");
      },
    },
    {
      name: "skips ingest for an id already registered natively",
      area: "guards",
      run: async () => {
        let ingestCalls = 0;
        const adapter = options.adapter();
        const counting: RatelAdapter<TTool, TMessage> = {
          ...adapter,
          ingest(id, tool) {
            ingestCalls++;
            return adapter.ingest(id, tool);
          },
        };
        const core = ratel();
        core.tools.register(nativeTool("shared_tool", "Shared grep tool."));
        const view = core.adaptTo(counting);
        view.tools.register({
          shared_tool: options.makeExecutableTool({ description: "would shadow" }),
        });
        assert.strictEqual(ingestCalls, 0, "a natively-registered id skips ingest entirely");
      },
    },
    {
      name: "keeps the base surface intact under extend",
      area: "guards",
      run: async () => {
        const view = ratel().adaptTo(options.adapter());
        view.tools.register({
          read_file: options.makeExecutableTool({ description: "Read a file from local disk." }),
        });
        assert.strictEqual(typeof view.tools.register, "function", "the tools handle survives");
        assert.strictEqual(typeof view.recall, "function", "recall survives");
        assert.ok(view.skills instanceof SkillCatalog, "the skills catalog survives");
        assert.deepStrictEqual(
          Object.keys(view.expose()).sort(),
          [...CAPABILITY_IDS].sort(),
          "expose() still returns exactly the capability set",
        );
      },
    },
    {
      name: "requires a non-empty adapter name",
      area: "guards",
      run: async () => {
        const adapter = options.adapter();
        assert.strictEqual(typeof adapter.name, "string", "the adapter carries a name");
        assert.ok(adapter.name.length > 0, "the adapter name is non-empty");
      },
    },
  ];
}

/** Sum the tool hits across every server group in a recall result. */
function countHits(result: SearchCapabilitiesResult): number {
  return result.tools.groups.reduce((n, g) => n + g.hits.length, 0);
}

/** 60 executable tools sharing query terms, so a recall over-fills its top-K budget. */
function manyGrepTools<TTool, TMessage>(
  options: AdapterConformanceOptions<TTool, TMessage>,
): Record<string, TTool> {
  const entries = Array.from({ length: 60 }, (_, i) => [
    `grep_${i}`,
    options.makeExecutableTool({ description: `Search files variant ${i}: grep ripgrep.` }),
  ]);
  return Object.fromEntries(entries) as Record<string, TTool>;
}

/** A native `ExecutableTool` for the guard cases that pre-register on the core directly. */
function nativeTool(id: string, description: string): ExecutableTool {
  return {
    id,
    name: id,
    description,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute: () => ({ ok: true }),
  };
}
