import type { JSONSchema7 } from "json-schema";
import type { SearchHit, Tool } from "../native/index.cjs";
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
  /** Max tools each host-driven `recall` returns: capped at 50; 0, negative, or
   * non-integer values fall back to the default 5. */
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
  /** Runs the tool through the capability funnel with just the args object. */
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
  /** Ratel capability tool → framework tool. */
  expose(tool: ExecutableTool): TTool;
  /** Synthetic recall pair in the framework's message shape. */
  recallMessages(ref: RecallRef, recall: SearchCapabilitiesResult): TMessage[];
  /** Framework-idiomatic helpers, merged onto the adapted object. */
  extend?(base: AdaptedBase<TTool, TMessage>): TExt;
}

/**
 * The core's handle over its shared {@link ToolCatalog} — registration and
 * lookup in the SDK's native shapes, callable at any time (also after
 * {@link Ratel.expose}: the capability tools search the live catalog at
 * invocation time). Guards live here: the reserved capability-tool ids throw,
 * and a framework-shaped tool throws an actionable install-the-adapter error.
 * Registration keeps the catalog's own replace-in-place semantics — the native
 * path is authoritative, unlike the first-wins adapted path — and embeds
 * incrementally on a semantic/hybrid catalog.
 */
export interface ToolCollection {
  /** Register native tools (replace-in-place on a duplicate id). Chainable. */
  register(...tools: ExecutableTool[]): this;
  /** Whether a tool with this id is registered. */
  has(id: string): boolean;
  /** The tool's searchable metadata, or `undefined` when unregistered. */
  get(id: string): Tool | undefined;
  /** Rank the catalog for `query` (host-driven, origin `"direct"`). */
  search(query: string, topK: number, method?: SearchMethod): SearchHit[];
  /** Execute a registered tool by id with the args object. */
  invoke(id: string, args: Record<string, unknown>): Promise<unknown>;
  /** The shared catalog itself — the unguarded driver-level escape hatch. */
  readonly catalog: ToolCatalog;
}

/**
 * An adapted view's handle over the same shared catalog, speaking the
 * framework's tool shape. Registration runs the adapter's `ingest` codec;
 * first registration of an id wins across every view of the core (and across
 * this view's passthroughs), so repeated calls are idempotent.
 */
export interface AdaptedToolCollection<TTool> {
  /** Ingest framework tools (keyed by tool id) into the shared catalog. Chainable. */
  register(tools: Record<string, TTool>): this;
  /** Whether this id is registered — in the catalog or as this view's passthrough. */
  has(id: string): boolean;
  /** The shared catalog itself — the unguarded driver-level escape hatch. */
  readonly catalog: ToolCatalog;
}

/**
 * The framework-shaped surface every adapter inherits from the core. Adapters
 * add their idioms via {@link RatelAdapter.extend}; universal capability lives
 * here.
 */
export interface AdaptedBase<TTool, TMessage> {
  /** This view's handle over the shared catalog, in the framework's tool shape. */
  readonly tools: AdaptedToolCollection<TTool>;
  /** The shared skill catalog (skills are framework-neutral). */
  readonly skills: SkillCatalog;
  /**
   * The model-facing toolset in the framework's shape: this view's passthroughs
   * plus the three capability tools run through the adapter's `expose` codec.
   * Fresh objects per call — take it once per agent instance and reuse it, so
   * the prompt cache survives. Tools registered later are still discoverable
   * (the capability tools search the live catalog); only a *passthrough*
   * registered later needs a re-expose to reach the model.
   */
  expose(): Record<string, TTool>;
  /**
   * Rank `query` and return the synthetic `search_capabilities` message pair in
   * the framework's shape (origin `"direct"`), or `[]` when nothing matched
   * (spending no call id). Pure: it builds fresh messages and never mutates a
   * host array.
   */
  recall(query: string): TMessage[];
}

/**
 * The object {@link Ratel.adaptTo} returns: the base surface plus the adapter's
 * `extend` helpers. An adapter whose `extend` returns a non-object degrades to
 * the bare base type here (instead of collapsing the whole view to `never`,
 * which would surface as a cryptic error far from the broken adapter).
 */
export type AdaptedRatel<A extends RatelAdapter> =
  A extends RatelAdapter<infer TTool, infer TMessage, infer TExt>
    ? AdaptedBase<TTool, TMessage> & (TExt extends object ? TExt : unknown)
    : never;

/**
 * One `ratel(config)` core: a single {@link ToolCatalog} + {@link SkillCatalog}
 * + recall-id counter shared by every {@link Ratel.adaptTo} view. Genuinely
 * usable standalone — register native tools on {@link Ratel.tools}, expose the
 * capability tools with {@link Ratel.expose}, rank with {@link Ratel.recall} —
 * and adaptable on top for a framework's native shapes.
 */
export interface Ratel {
  /** Handle over the shared tool catalog (native shapes, guarded). */
  readonly tools: ToolCollection;
  /** The shared skill catalog. */
  readonly skills: SkillCatalog;
  /**
   * The three capability tools (`search_capabilities`, `invoke_tool`,
   * `get_skill_content`) in native shape, for framework-free hosts. All three
   * are always advertised — the set never depends on registration order, so the
   * prompt cache survives; loading a skill from an empty catalog returns a
   * structured error, not a missing tool. Fresh objects per call: take it once
   * and reuse it. Tools and skills registered later are still discoverable.
   */
  expose(): Record<string, ExecutableTool>;
  /**
   * Rank `query` into the canonical `search_capabilities` result (origin
   * `"direct"`, top-K from `recallTopK`), or `null` when nothing matched. A
   * pure query: no call id is minted — ids exist only on the adapted views,
   * whose synthetic message pairs need them.
   */
  recall(query: string): SearchCapabilitiesResult | null;
  /** Adapt the core to a framework, inferring its tool/message types and helpers. */
  adaptTo<A extends RatelAdapter>(adapter: A): AdaptedRatel<A>;
}

// The capability-tool ids: an app tool may not shadow them (registration throws).
const RESERVED_TOOL_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);

// Catalog default when an adapter's registration omits an output schema.
const DEFAULT_OUTPUT_SCHEMA: JSONSchema7 = { type: "object" };

// Frameworks probed (for error messages only — detection can't tell installed
// from in use) to point a framework-shaped registration at the exact adapter.
const KNOWN_FRAMEWORKS: readonly {
  readonly pkg: string;
  readonly adapter: string;
  readonly factory: string;
}[] = [
  { pkg: "ai", adapter: "@ratel-ai/ai-sdk-adapter", factory: "aiSdk" },
  { pkg: "@mastra/core", adapter: "@ratel-ai/mastra-adapter", factory: "mastra" },
];

/**
 * Create a framework-neutral Ratel core. It works standalone — register native
 * tools on `r.tools`, skills on `r.skills`, hand the model `r.expose()`, rank
 * with `r.recall(query)` — and {@link Ratel.adaptTo | adapts} to a framework
 * with a {@link RatelAdapter} for that framework's native shapes. The core owns
 * all state (the catalogs, the recall-id counter) and every
 * framework-independent guard — reserved capability-tool ids, top-K clamping,
 * first-registration-wins on the adapted path, passthrough of non-executable
 * tools — so adapters stay tiny. One core can back several adapter views (they
 * share the catalog, embeddings, and counter).
 *
 * @param config - Retrieval method, recall budget, and trace sink.
 * @returns The standalone core; call `.adaptTo(adapter())` for a framework-shaped view.
 *
 * @example
 * ```ts
 * import { ratel } from "@ratel-ai/sdk";
 * import { aiSdk } from "@ratel-ai/ai-sdk-adapter";
 *
 * const r = ratel({ recallTopK: 5 }).adaptTo(aiSdk());
 * r.tools.register(myTools);
 * const tools = r.expose(); // stable capability set for the model — take once, reuse
 * const messages = r.appendRecall(history); // per-turn recall (AI SDK idiom)
 * ```
 */
export function ratel(config: RatelConfig = {}): Ratel {
  const catalog = new ToolCatalog({ method: config.method, trace: config.trace });
  const skills = new SkillCatalog({ method: config.method, trace: config.trace });
  // Recall call ids come from a private counter shared across every view of this
  // core: transcript positions are caller-owned (trimming/compaction repeats
  // them as tool-call ids), so they can't be the id source.
  let recallSeq = 0;

  const tools: ToolCollection = {
    catalog,
    register(...items) {
      for (const tool of items) {
        assertNativeTool(tool);
        assertUnreservedId(tool.id);
        catalog.register(tool); // catalog semantics: replace-in-place, embed incrementally
      }
      return tools;
    },
    has: (id) => catalog.has(id),
    get: (id) => catalog.get(id),
    search: (query, topK, method) => catalog.search(query, topK, "direct", method),
    invoke: (id, args) => catalog.invoke(id, args),
  };

  function expose(): Record<string, ExecutableTool> {
    return {
      // advertiseSkills pins the skills clause of the description: the exposed
      // payload must be byte-identical whether skills register before or after.
      [SEARCH_CAPABILITIES_ID]: searchCapabilitiesTool(catalog, skills, {
        advertiseSkills: true,
      }),
      [INVOKE_TOOL_ID]: invokeToolTool(catalog),
      [GET_SKILL_CONTENT_ID]: getSkillContentTool(skills),
    };
  }

  function recall(query: string): SearchCapabilitiesResult | null {
    const result = formatSearchCapabilities(catalog, query, {
      topKTools: config.recallTopK, // capped/validated inside the formatter
      skillCatalog: skills,
      origin: "direct",
    });
    return result.tools.groups.length === 0 && result.skills.length === 0 ? null : result;
  }

  function adaptTo<A extends RatelAdapter>(adapter: A): AdaptedRatel<A> {
    assertAdapter(adapter);
    // Provider- or client-executed tools: framework-shaped, so per view — a
    // Mastra view must never expose an AI SDK passthrough.
    const passthrough = new Map<string, unknown>();

    const adaptedTools: AdaptedToolCollection<unknown> = {
      catalog,
      has: (id) => catalog.has(id) || passthrough.has(id),
      register(appTools) {
        for (const [id, tool] of Object.entries(appTools)) {
          assertUnreservedId(id);
          // First registration of an id wins, across every view of the core
          // and across this view's passthroughs — repeated calls are idempotent.
          if (catalog.has(id) || passthrough.has(id)) continue;
          const registration = adapter.ingest(id, tool);
          if (registration === "passthrough") {
            passthrough.set(id, tool);
            continue;
          }
          catalog.register({
            id,
            name: id,
            description: registration.description,
            inputSchema: registration.inputSchema,
            outputSchema: registration.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
            execute: registration.execute,
          });
        }
        return adaptedTools;
      },
    };

    const base: AdaptedBase<unknown, unknown> = {
      tools: adaptedTools,
      skills,
      expose() {
        const out: Record<string, unknown> = Object.fromEntries(passthrough);
        for (const [id, tool] of Object.entries(expose())) {
          out[id] = adapter.expose(tool);
        }
        return out;
      },
      recall(query) {
        const result = recall(query);
        if (result === null) return []; // nothing matched: don't spend a call id
        return adapter.recallMessages({ callId: `recall_${recallSeq++}`, query }, result);
      },
    };
    // Generics are erased inside the implementation; the public signature keeps
    // them, so cast the base at the extend boundary and on return.
    const ext = adapter.extend ? adapter.extend(base as AdaptedBase<never, never>) : {};
    return { ...base, ...ext } as AdaptedRatel<A>;
  }

  return { tools, skills, expose, recall, adaptTo };
}

/** Reject a reserved capability-tool id (the funnel's vocabulary can't be shadowed). */
function assertUnreservedId(id: string): void {
  if (RESERVED_TOOL_IDS.has(id)) {
    throw new Error(`ratel: tool id "${id}" is reserved for the capability tools`);
  }
}

/**
 * Reject a framework-shaped tool on the native registration path with the
 * actionable install-the-adapter error. Fingerprints, not full validation: a
 * zod-style schema, a dynamic (function) description, or a missing id — the
 * marks of a framework tool that belongs on an adapted view — trigger
 * {@link unadaptedError}; everything else is the catalog's job to validate.
 */
function assertNativeTool(tool: ExecutableTool): void {
  const candidate = tool as {
    id?: unknown;
    description?: unknown;
    inputSchema?: unknown;
  } | null;
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError(`ratel: tools.register() expects ExecutableTools; got ${typeof tool}`);
  }
  const schema = candidate.inputSchema as { _def?: unknown; safeParse?: unknown } | undefined;
  const frameworkShaped =
    typeof candidate.id !== "string" ||
    typeof candidate.description === "function" ||
    (typeof schema === "object" &&
      schema !== null &&
      (schema._def !== undefined || typeof schema.safeParse === "function"));
  if (frameworkShaped) throw unadaptedError(isPeerInstalled);
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
 * Build the error thrown when a framework-shaped tool hits the native
 * `ratel().tools.register(...)` path. When a known framework is present in the
 * tree, name its exact adapter package and factory; otherwise a generic
 * adapt-first message. Exported (module-internal, not re-exported from the
 * package) so the detected-framework branch is testable with an injected probe.
 *
 * @param isInstalled - Peer-resolution probe (the real {@link isPeerInstalled}).
 * @returns The error to throw.
 */
export function unadaptedError(isInstalled: (specifier: string) => boolean): Error {
  const intro =
    "ratel: this looks like a framework tool, not a native ExecutableTool. " +
    "Register framework tools on an adapted view: `ratel(config).adaptTo(adapter()).tools.register(...)`.";
  const detected = KNOWN_FRAMEWORKS.filter((f) => isInstalled(f.pkg));
  if (detected.length === 0) return new Error(intro);
  const lines = detected.map(
    (f) =>
      `  - ${f.pkg}: install \`${f.adapter}\` and register via \`ratel(config).adaptTo(${f.factory}()).tools.register(...)\``,
  );
  return new Error(`${intro} Detected in your dependencies:\n${lines.join("\n")}`);
}
