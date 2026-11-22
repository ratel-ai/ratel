import { NOTES_ONLY_KINDS } from "@/lib/synthesis/tool-crafter/kinds";
import type {
  CraftedProposalBody,
  CraftedToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * The checks every crafted definition passes before it is stored, written by
 * hand because the app carries no JSON Schema validator and the shapes the
 * catalog accepts are narrow. They ask three things: is the input schema a
 * well-formed object schema; does the crafted tool still take every argument
 * the source tools required (or say where it went); and is the name one a
 * tool registry accepts and no other tool already has.
 */

export const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_SCHEMA_DEPTH = 4;
export const MAX_SEARCHABLE_CHARS = 1_500;

const PRIMITIVES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export type Check = { ok: true } | { ok: false; problems: string[] };

function depthOf(value: unknown, depth = 0): number {
  if (!value || typeof value !== "object") return depth;
  let max = depth;
  for (const child of Object.values(value as Record<string, unknown>))
    max = Math.max(max, depthOf(child, depth + 1));
  return max;
}

function typeOk(type: unknown): boolean {
  if (typeof type === "string") return PRIMITIVES.has(type);
  if (Array.isArray(type))
    return type.length > 0 && type.every((t) => typeof t === "string" && PRIMITIVES.has(t));
  return false;
}

/** An object schema whose properties are typed, whose `required` names real properties, with no `$ref`. */
export function validateInputSchema(schema: unknown): Check {
  const problems: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return { ok: false, problems: ["input schema is not an object"] };
  const s = schema as JsonSchemaObject;
  if (s.type !== "object")
    problems.push(`input schema type is ${JSON.stringify(s.type)}, not "object"`);
  if (
    s.properties !== undefined &&
    (typeof s.properties !== "object" || Array.isArray(s.properties))
  )
    problems.push("properties is not an object");
  const properties =
    s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
      ? s.properties
      : {};
  for (const [name, property] of Object.entries(properties)) {
    if (!property || typeof property !== "object") {
      problems.push(`property ${name} is not an object`);
      continue;
    }
    const hasType = typeOk(property.type);
    const hasAlternative =
      Array.isArray(property.enum) ||
      Array.isArray(property.anyOf) ||
      Array.isArray(property.oneOf);
    if (!hasType && !hasAlternative) problems.push(`property ${name} has no type`);
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string"))
      problems.push("required is not a list of names");
    else
      for (const name of s.required)
        if (!(name in properties)) problems.push(`required names ${name}, which is not a property`);
  }
  const text = JSON.stringify(schema);
  if (text.includes('"$ref"')) problems.push("$ref is not allowed");
  if (Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES)
    problems.push(`input schema is over ${MAX_SCHEMA_BYTES} bytes`);
  if (depthOf(schema) > MAX_SCHEMA_DEPTH)
    problems.push(`input schema is nested deeper than ${MAX_SCHEMA_DEPTH}`);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

function requiredOf(schema: JsonSchemaObject | null): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
}

function propertiesOf(schema: JsonSchemaObject | null): string[] {
  return schema?.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties)
    : [];
}

/**
 * Every argument a source tool required is still reachable: present under the
 * same name in some crafted tool, named in that source's dispatch mapping, or
 * derived (from an earlier source's result or a literal). For a rewrite the
 * crafted tool may not drop a required argument at all.
 */
export function checkParamCoverage(
  sources: readonly SourceTool[],
  proposal: Pick<CraftedProposalBody, "kind" | "crafted" | "hidden">,
): Check {
  const problems: string[] = [];
  const craftedParams = new Set(proposal.crafted.flatMap((tool) => propertiesOf(tool.inputSchema)));
  for (const source of sources) {
    if (
      proposal.kind === "deprecate_tool" ||
      NOTES_ONLY_KINDS.has(proposal.kind) ||
      (proposal.hidden.includes(source.id) && proposal.crafted.length === 0)
    )
      continue;
    const notes = proposal.crafted.flatMap((tool) =>
      tool.dispatch.filter((d) => d.sourceToolId === source.id),
    );
    const mapped = new Set(notes.flatMap((d) => Object.keys(d.argumentMapping)));
    const mappedTo = new Set(notes.flatMap((d) => Object.values(d.argumentMapping)));
    const derived = new Set(notes.flatMap((d) => Object.keys(d.derived ?? {})));
    for (const target of mappedTo)
      if (!craftedParams.has(target))
        problems.push(`${source.id}: argument mapped to ${target}, which no crafted tool takes`);
    for (const param of requiredOf(source.inputSchema)) {
      if (craftedParams.has(param) || mapped.has(param) || derived.has(param)) continue;
      problems.push(`${source.id}: required argument ${param} is neither kept, mapped nor derived`);
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** A derived origin is `"<sourceToolId>.output.<path>"` or `"literal:<json>"`. */
export function parseDerived(
  origin: string,
):
  | { kind: "output"; sourceToolId: string; path: string }
  | { kind: "literal"; value: unknown }
  | null {
  if (origin.startsWith("literal:")) {
    try {
      return { kind: "literal", value: JSON.parse(origin.slice("literal:".length)) };
    } catch {
      return null;
    }
  }
  const at = origin.indexOf(".output");
  if (at <= 0) return null;
  const path = origin.slice(at + ".output".length).replace(/^\./, "");
  return { kind: "output", sourceToolId: origin.slice(0, at), path };
}

/**
 * The dispatch holds together as a handler: every source the crafted tools
 * stand in for has a note; a derived argument comes from a literal or from a
 * source that runs earlier in the same crafted tool; a merge or fold adds no
 * required argument that no source required; a split piece takes only
 * arguments its source had.
 */
export function checkDispatch(
  sources: readonly SourceTool[],
  proposal: Pick<CraftedProposalBody, "kind" | "crafted" | "hidden" | "sourceToolIds">,
): Check {
  const problems: string[] = [];
  if (proposal.kind === "deprecate_tool" || NOTES_ONLY_KINDS.has(proposal.kind))
    return { ok: true };
  const sourceIds = new Set(sources.map((s) => s.id));
  const noted = new Set(
    proposal.crafted.flatMap((tool) => tool.dispatch.map((d) => d.sourceToolId)),
  );
  for (const id of proposal.sourceToolIds)
    if (!noted.has(id))
      problems.push(`${id}: no dispatch note says how the crafted tool stands in for it`);
  const sourceRequired = new Set(sources.flatMap((s) => requiredOf(s.inputSchema)));
  for (const tool of proposal.crafted) {
    const orderOf = new Map(tool.dispatch.map((d, i) => [d.sourceToolId, d.order ?? i]));
    for (const note of tool.dispatch) {
      if (!sourceIds.has(note.sourceToolId))
        problems.push(
          `${tool.name}: dispatch names ${note.sourceToolId}, which is not a source tool`,
        );
      for (const [arg, origin] of Object.entries(note.derived ?? {})) {
        const parsed = parseDerived(origin);
        if (!parsed) {
          problems.push(
            `${tool.name}: ${note.sourceToolId}.${arg} is derived from ${JSON.stringify(origin)}, which is neither <source>.output.<path> nor literal:<json>`,
          );
          continue;
        }
        if (parsed.kind !== "output") continue;
        const from = orderOf.get(parsed.sourceToolId);
        if (from === undefined)
          problems.push(
            `${tool.name}: ${note.sourceToolId}.${arg} is derived from ${parsed.sourceToolId}, which the tool does not call`,
          );
        else if (from >= (orderOf.get(note.sourceToolId) ?? 0))
          problems.push(
            `${tool.name}: ${note.sourceToolId}.${arg} is derived from ${parsed.sourceToolId}, which runs after it`,
          );
      }
    }
    if (
      proposal.kind === "merge_tools" ||
      proposal.kind === "fold_prerequisite" ||
      proposal.kind === "compose_chain" ||
      proposal.kind === "require_prerequisite"
    ) {
      const mappedFrom = new Map(
        tool.dispatch.flatMap((d) =>
          Object.entries(d.argumentMapping).map(([from, to]) => [to, from] as const),
        ),
      );
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown }>;
      let selectors = 0;
      for (const req of requiredOf(tool.inputSchema)) {
        const origin = mappedFrom.get(req) ?? req;
        if (sourceRequired.has(origin)) continue;
        // One new required enum is the mode selector a merge of swapped siblings needs; anything else is an invented demand on the agent.
        if (Array.isArray(properties[req]?.enum) && selectors === 0) {
          selectors += 1;
          continue;
        }
        problems.push(`${tool.name}: requires ${req}, which no source tool required`);
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

function propertyOf(schema: JsonSchemaObject | null, name: string): JsonSchemaProperty | undefined {
  return schema?.properties && typeof schema.properties === "object"
    ? schema.properties[name]
    : undefined;
}

/**
 * Every source argument a crafted tool passes on lands on a property of the
 * same type: a merge that maps an integer `id` onto a string property has let
 * one side win, even when every name is covered.
 */
export function checkArgumentTypes(
  sources: readonly SourceTool[],
  proposal: Pick<CraftedProposalBody, "crafted">,
): Check {
  const problems: string[] = [];
  for (const tool of proposal.crafted) {
    for (const note of tool.dispatch) {
      const source = sources.find((s) => s.id === note.sourceToolId);
      if (!source) continue;
      for (const arg of propertiesOf(source.inputSchema)) {
        if (note.derived && arg in note.derived) continue;
        const target = note.argumentMapping[arg] ?? arg;
        const from = propertyOf(source.inputSchema, arg);
        const to = propertyOf(tool.inputSchema, target);
        if (!from || !to) continue;
        if (JSON.stringify(from.type ?? null) !== JSON.stringify(to.type ?? null))
          problems.push(
            `${source.id}: argument ${arg} is ${JSON.stringify(from.type ?? null)} but ${tool.name} takes it as ${target}, ${JSON.stringify(to.type ?? null)}`,
          );
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** A registry-safe name that no other tool in the catalog has (a rewrite may keep its own). */
export function checkName(
  crafted: Pick<CraftedToolDefinition, "name">,
  catalogIds: ReadonlySet<string>,
  allowed: ReadonlySet<string> = new Set(),
): Check {
  const problems: string[] = [];
  if (!TOOL_NAME_PATTERN.test(crafted.name))
    problems.push(
      `name ${JSON.stringify(crafted.name)} is not a tool name (letters, digits, _ and -, 2 to 64 chars)`,
    );
  if (catalogIds.has(crafted.name) && !allowed.has(crafted.name))
    problems.push(`name ${crafted.name} is already a tool in the catalog`);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Every check a proposal must pass before it is stored; problems are joined from all of them. */
export function checkProposal(
  sources: readonly SourceTool[],
  proposal: CraftedProposalBody,
  catalogIds: ReadonlySet<string>,
): Check {
  const problems: string[] = [];
  const allowed = new Set(
    proposal.kind === "rewrite_tool" || proposal.kind === "parallel_pair"
      ? proposal.sourceToolIds
      : [],
  );
  const seen = new Set<string>();
  for (const tool of proposal.crafted) {
    if (seen.has(tool.name)) problems.push(`two crafted tools are both named ${tool.name}`);
    seen.add(tool.name);
    const name = checkName(tool, catalogIds, allowed);
    if (!name.ok) problems.push(...name.problems);
    const schema = validateInputSchema(tool.inputSchema);
    if (!schema.ok) problems.push(...schema.problems.map((p) => `${tool.name}: ${p}`));
    if (tool.description.trim().length === 0) problems.push(`${tool.name}: description is empty`);
    if (tool.searchableDescription.trim().length === 0)
      problems.push(`${tool.name}: searchable description is empty`);
    if (tool.searchableDescription.length > MAX_SEARCHABLE_CHARS)
      problems.push(`${tool.name}: searchable description is over ${MAX_SEARCHABLE_CHARS} chars`);
  }
  for (const id of proposal.hidden)
    if (!proposal.sourceToolIds.includes(id))
      problems.push(`hidden tool ${id} is not a source tool`);
  const coverage = checkParamCoverage(sources, proposal);
  if (!coverage.ok) problems.push(...coverage.problems);
  const dispatch = checkDispatch(sources, proposal);
  if (!dispatch.ok) problems.push(...dispatch.problems);
  const types = checkArgumentTypes(sources, proposal);
  if (!types.ok) problems.push(...types.problems);
  if (proposal.kind === "merge_tools" && proposal.crafted.length !== 1)
    problems.push("a merge crafts exactly one tool");
  if (
    proposal.kind === "deprecate_tool" &&
    (proposal.crafted.length !== 0 || proposal.hidden.length !== 1)
  )
    problems.push("a deprecation hides one tool and crafts none");
  if (
    proposal.kind === "compose_chain" &&
    (proposal.crafted.length !== 1 || proposal.sourceToolIds.length < 3)
  )
    problems.push("a composed chain crafts exactly one tool from three or more");
  if (proposal.kind === "require_prerequisite" && proposal.crafted.length !== 1)
    problems.push("a prerequisite crafts exactly one tool");
  if (
    NOTES_ONLY_KINDS.has(proposal.kind) &&
    (proposal.crafted.length !== 0 || proposal.hidden.length !== 0)
  )
    problems.push(
      "a schema tightening, a response enrichment, a pre-load, a split by use or a gap crafts and hides nothing; the edit is in the notes",
    );
  if (proposal.kind === "parallel_pair") {
    if (proposal.crafted.length !== 2 || proposal.hidden.length !== 0)
      problems.push("a parallel pair keeps both tools and hides none");
    for (const tool of proposal.crafted) {
      const source = sources.find((s) => s.id === tool.name);
      if (!source) problems.push(`${tool.name}: a parallel pair keeps the source names`);
      else if (
        JSON.stringify(source.inputSchema ?? { type: "object", properties: {} }) !==
        JSON.stringify(tool.inputSchema)
      )
        problems.push(`${tool.name}: a parallel pair keeps the schema`);
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
