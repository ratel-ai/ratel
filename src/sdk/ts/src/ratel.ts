import type { JSONSchema7 } from "json-schema";
import {
  formatSearchCapabilities,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_CAPABILITIES_ID,
  type SearchCapabilitiesResult,
  searchCapabilitiesTool,
} from "./capabilities.js";
import {
  type ExecutableTool,
  type SearchMethod,
  ToolCatalog,
  type TraceSinkConfig,
} from "./catalog.js";
import { SkillCatalog } from "./skill-catalog.js";
import { GET_SKILL_CONTENT_ID, getSkillContentTool } from "./skill-tools.js";
import { isPeerInstalled } from "./telemetry.js";

/** Construction options for {@link ratel}. Shared by every adapter view of the core. */
export interface RatelConfig {
  /** Default retrieval method for the tool and skill catalogs (default `"bm25"`, model-free). */
  method?: SearchMethod;
  /** Max tools each host-driven `recall` injects, clamped to [1, 50] (default 5). */
  recallTopK?: number;
  /** Local trace-stream destination for both catalogs (default: discard). */
  trace?: TraceSinkConfig;
}

/**
 * A framework tool ingested into the catalog: what an adapter's
 * {@link RatelAdapter.ingest} returns for an executable tool. The core registers
 * it verbatim (id/name are the app's tool key), so the schemas are the SDK's
 * public {@link JSONSchema7} spelling and adapters need no casts.
 */
export interface CatalogRegistration {
  /** Retrieval ranks on this; resolve dynamic descriptions at ingest time. */
  description: string;
  /** Input JSON Schema (the catalog's native spelling). */
  inputSchema: JSONSchema7;
  /** Output JSON Schema; defaults to `{ type: "object" }` when omitted. */
  outputSchema?: JSONSchema7;
  /** Runs the tool through the gateway with just the args object. */
  execute(input: unknown): Promise<unknown> | unknown;
}

/** The identity of one synthetic recall call, handed to {@link RatelAdapter.recallMessages}. */
export interface RecallRef {
  /** Unique call id from the core's private counter (never a transcript position). */
  callId: string;
  /** The recall query (the last user turn's text, in the AI SDK adapter). */
  query: string;
}

/**
 * The framework boundary: one complementary package per framework implements
 * this so Ratel speaks that framework's native tool and message shapes. The
 * three codecs (`ingest` / `expose` / `recallMessages`) are the whole contract;
 * `extend` adds framework idioms. The core owns all state and guards, so an
 * adapter is ~three pure functions.
 *
 * @typeParam TTool - The framework's tool type (e.g. AI SDK `Tool`).
 * @typeParam TMessage - The framework's message type (e.g. AI SDK `ModelMessage`).
 * @typeParam TExt - The framework-idiomatic helpers merged onto the adapted object.
 */
export interface RatelAdapter<
  TTool = unknown,
  TMessage = unknown,
  TExt extends object = Record<never, never>,
> {
  /** Stamped on telemetry (`ratel.adapter`) and error messages. */
  readonly name: string;
  /**
   * Framework tool → catalog registration, or `"passthrough"` for tools the
   * catalog can't execute (provider-executed) that must stay eagerly exposed.
   */
  ingest(id: string, tool: TTool): CatalogRegistration | "passthrough";
  /** Ratel capability tool → framework tool (gateway exposure). */
  expose(tool: ExecutableTool): TTool;
  /** Synthetic recall pair in the framework's message shape. */
  recallMessages(ref: RecallRef, recall: SearchCapabilitiesResult): TMessage[];
  /** Framework-idiomatic helpers, merged onto the adapted object. */
  extend?(base: AdaptedBase<TTool, TMessage>): TExt;
}

/**
 * The framework-shaped surface every adapter inherits from the core. Adapters
 * add their idioms via {@link RatelAdapter.extend}; universal capability lives
 * here.
 */
export interface AdaptedBase<TTool, TMessage> {
  /**
   * Ingest the app's framework tools into the catalog and return the stable
   * gateway set (`search_capabilities` + `invoke_tool`, plus `get_skill_content`
   * when a skill is registered) alongside any passthroughs. The set never
   * changes across turns, so the prompt cache survives. First registration of an
   * id wins; the gateway ids are reserved.
   */
  tools(tools: Record<string, TTool>): Record<string, TTool>;
  /**
   * Rank `query` and return the synthetic `search_capabilities` message pair in
   * the framework's shape (origin `"direct"`), or `[]` when nothing matched.
   * Pure: it builds fresh messages and never mutates a host array.
   */
  recall(query: string): TMessage[];
  /** Escape hatch: the shared tool catalog. */
  readonly catalog: ToolCatalog;
  /** Escape hatch: the shared skill catalog. */
  readonly skills: SkillCatalog;
}

/** The object {@link RatelCore.adaptTo} returns: the base surface plus the adapter's `extend` helpers. */
export type AdaptedRatel<A extends RatelAdapter> =
  A extends RatelAdapter<infer TTool, infer TMessage, infer TExt>
    ? AdaptedBase<TTool, TMessage> & TExt
    : never;

/**
 * One `ratel(config)` core: a single {@link ToolCatalog} + {@link SkillCatalog}
 * + recall-id counter shared by every {@link RatelCore.adaptTo} view. The
 * framework-free escape hatches (`catalog`, `skills`) stay available; the
 * framework-shaped `tools` / `recall` throw until adapted.
 */
export interface RatelCore {
  /** Adapt the core to a framework, inferring its tool/message types and helpers. */
  adaptTo<A extends RatelAdapter>(adapter: A): AdaptedRatel<A>;
  /** Framework-free escape hatch: the shared tool catalog. */
  readonly catalog: ToolCatalog;
  /** Framework-free escape hatch: the shared skill catalog. */
  readonly skills: SkillCatalog;
  /** @throws — adapt first with `.adaptTo(<adapter>())`. */
  tools(tools?: Record<string, unknown>): never;
  /** @throws — adapt first with `.adaptTo(<adapter>())`. */
  recall(query?: string): never;
}

// The gateway capability-tool ids: an app tool may not shadow them (registration throws).
const RESERVED_TOOL_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);

// Catalog default when an adapter's registration omits an output schema.
const DEFAULT_OUTPUT_SCHEMA: JSONSchema7 = { type: "object" };

// Frameworks probed (for error messages only — detection can't tell installed
// from in use) to point an un-adapted host at the exact adapter to install.
const KNOWN_FRAMEWORKS: readonly {
  readonly pkg: string;
  readonly adapter: string;
  readonly factory: string;
}[] = [
  { pkg: "ai", adapter: "@ratel-ai/ai-sdk-adapter", factory: "aiSdk" },
  { pkg: "@mastra/core", adapter: "@ratel-ai/mastra-adapter", factory: "mastra" },
];

/**
 * Create a framework-neutral Ratel core, then {@link RatelCore.adaptTo | adapt}
 * it to a framework with a {@link RatelAdapter}. The core owns all state (the
 * tool/skill catalogs, the recall-id counter) and every framework-independent
 * guard — reserved gateway ids, top-K clamping, first-registration-wins,
 * passthrough of non-executable tools — so adapters stay tiny. One core can back
 * several adapter views (they share the catalog, embeddings, and counter).
 *
 * @param config - Retrieval method, recall budget, and trace sink.
 * @returns The core; call `.adaptTo(adapter())` to get the framework-shaped view.
 *
 * @example
 * ```ts
 * import { ratel } from "@ratel-ai/sdk";
 * import { aiSdk } from "@ratel-ai/ai-sdk-adapter";
 *
 * const r = ratel({ recallTopK: 5 }).adaptTo(aiSdk());
 * const tools = r.tools(myTools); // stable gateway set for the model
 * const messages = r.appendRecall(history); // per-turn recall (AI SDK idiom)
 * ```
 */
export function ratel(config: RatelConfig = {}): RatelCore {
  const catalog = new ToolCatalog({ method: config.method, trace: config.trace });
  const skills = new SkillCatalog({ method: config.method, trace: config.trace });
  // Recall call ids come from a private counter shared across every view of this
  // core: transcript positions are caller-owned (trimming/compaction repeats
  // them as tool-call ids), so they can't be the id source.
  let recallSeq = 0;

  function adaptTo<A extends RatelAdapter>(adapter: A): AdaptedRatel<A> {
    assertAdapter(adapter);
    const base: AdaptedBase<unknown, unknown> = {
      catalog,
      skills,
      tools(appTools) {
        const passthrough: Record<string, unknown> = {};
        for (const [id, tool] of Object.entries(appTools)) {
          if (RESERVED_TOOL_IDS.has(id)) {
            throw new Error(`ratel: tool id "${id}" is reserved for the gateway`);
          }
          const registration = adapter.ingest(id, tool);
          if (registration === "passthrough") {
            // Provider- or client-executed: not invocable through the catalog,
            // so it stays eagerly exposed to keep working.
            passthrough[id] = tool;
            continue;
          }
          if (catalog.has(id)) continue; // first registration of an id wins
          catalog.register({
            id,
            name: id,
            description: registration.description,
            inputSchema: registration.inputSchema,
            outputSchema: registration.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
            execute: registration.execute,
          });
        }
        catalog.buildEmbeddings(); // incremental; no-op on a BM25 catalog
        const gateway: Record<string, unknown> = {
          [SEARCH_CAPABILITIES_ID]: adapter.expose(searchCapabilitiesTool(catalog, skills)),
          [INVOKE_TOOL_ID]: adapter.expose(invokeToolTool(catalog)),
        };
        // Only advertise get_skill_content when there is a skill to load, so the
        // gateway set matches search_capabilities' own skills-bucket gating.
        if (skills.size() > 0) {
          gateway[GET_SKILL_CONTENT_ID] = adapter.expose(getSkillContentTool(skills));
        }
        return { ...passthrough, ...gateway };
      },
      recall(query) {
        const recall = formatSearchCapabilities(catalog, query, {
          topKTools: config.recallTopK, // clamped to [1, 50] inside the formatter
          skillCatalog: skills,
          origin: "direct",
        });
        // Nothing matched: don't spend a call id or inject an empty pair.
        if (recall.tools.groups.length === 0 && recall.skills.length === 0) return [];
        return adapter.recallMessages({ callId: `recall_${recallSeq++}`, query }, recall);
      },
    };
    // Generics are erased inside the implementation; the public signature keeps
    // them, so cast the base at the extend boundary and on return.
    const ext = adapter.extend ? adapter.extend(base as AdaptedBase<never, never>) : {};
    return { ...base, ...ext } as AdaptedRatel<A>;
  }

  return {
    adaptTo,
    catalog,
    skills,
    tools() {
      throw unadaptedError(isPeerInstalled);
    },
    recall() {
      throw unadaptedError(isPeerInstalled);
    },
  };
}

/** Reject a non-adapter early (JS callers) with a message that names it via `adapter.name`. */
function assertAdapter(adapter: RatelAdapter): void {
  if (
    !adapter ||
    typeof adapter.ingest !== "function" ||
    typeof adapter.expose !== "function" ||
    typeof adapter.recallMessages !== "function"
  ) {
    const label =
      adapter && typeof adapter.name === "string" ? `"${adapter.name}"` : `${typeof adapter}`;
    throw new Error(
      `ratel: adaptTo() requires a RatelAdapter with ingest/expose/recallMessages; got ${label}`,
    );
  }
}

/**
 * Build the error thrown when a `ratel()` core is used framework-shaped without
 * `.adaptTo(...)`. When a known framework is present in the tree, name its exact
 * adapter package and factory; otherwise a generic adapt-first message. Exported
 * (module-internal, not re-exported from the package) so the detected-framework
 * branch is testable with an injected probe.
 *
 * @param isInstalled - Peer-resolution probe (the real {@link isPeerInstalled}).
 * @returns The error to throw.
 */
export function unadaptedError(isInstalled: (specifier: string) => boolean): Error {
  const detected = KNOWN_FRAMEWORKS.filter((f) => isInstalled(f.pkg));
  if (detected.length === 0) {
    return new Error(
      "ratel(config) must be adapted before use: call `.adaptTo(adapter())` with a RatelAdapter, " +
        "e.g. `import { aiSdk } from '@ratel-ai/ai-sdk-adapter'; ratel(config).adaptTo(aiSdk())`.",
    );
  }
  const lines = detected.map(
    (f) =>
      `  - ${f.pkg}: install \`${f.adapter}\` and call \`ratel(config).adaptTo(${f.factory}())\``,
  );
  return new Error(
    `ratel(config) must be adapted to your framework before use. Detected in your dependencies:\n${lines.join(
      "\n",
    )}`,
  );
}
