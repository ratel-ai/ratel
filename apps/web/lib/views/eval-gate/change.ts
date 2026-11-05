import type { FixKind } from "@/lib/views/fixes/kinds";
import type { Fix } from "@/lib/views/fixes/types";
import type { AddedTool, CraftedToolDef, FixChange, ReplayChange } from "./types";

/**
 * A fix as the change the simulator applies (`FixChange`). Read from the fix
 * model every page already loads (`lib/fixes`), so the gate simulates exactly
 * the change Fixes shows: a rewrite's proposed text, a drafted change's crafted
 * definitions, an issue's named change. Pure.
 *
 * Kinds whose effect lives in the customer's code and not in anything a stored
 * run records (a tool that does not exist yet, a split, pre-loaded context)
 * say so instead of inventing a number.
 */

/** Kinds whose calls collapse into one: the pair or chain becomes one call. */
const COLLAPSING: ReadonlySet<FixKind> = new Set([
  "merge",
  "combine",
  "fold",
  "enrich",
  "parallel",
  "prerequisite",
]);
/** Kinds whose failed calls stop being retried. */
const RETRYING: ReadonlySet<FixKind> = new Set(["fail-clearly", "schema"]);

const UNSUPPORTED: Partial<Record<FixKind, string>> = {
  build: "A tool that doesn't exist yet has no past runs to replay.",
  split: "Splitting a tool changes calls the past runs never made.",
  preload: "Pre-loaded context changes what the model reads, which past runs don't record.",
};

export function emptyChange(): FixChange {
  return {
    version: 1,
    patches: {},
    hide: [],
    add: [],
    collapse: [],
    dedupeRetries: [],
    topK: null,
    skillSteps: [],
    unsupportedReason: null,
  };
}

interface CraftedJson {
  name: string;
  searchable: string;
  /** RC-61: what the model is offered: its description, its argument schema, the tools it dispatches to in order. */
  description: string;
  parameters: Record<string, unknown>;
  sources: string[];
}

/** A crafted definition's name and searchable text, from the JSON Fixes shows; null when it doesn't parse. */
export function parseCrafted(json: string): CraftedJson | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const description = typeof value.description === "string" ? value.description.trim() : "";
    const searchable =
      typeof value.searchableDescription === "string" &&
      value.searchableDescription.trim().length > 0
        ? value.searchableDescription.trim()
        : description;
    const schema =
      value.inputSchema &&
      typeof value.inputSchema === "object" &&
      !Array.isArray(value.inputSchema)
        ? (value.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    const dispatch = Array.isArray(value.dispatch) ? value.dispatch : [];
    const sources = dispatch
      .map((step) =>
        step && typeof step === "object" ? (step as Record<string, unknown>).sourceToolId : null,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return name && searchable
      ? {
          name,
          searchable,
          description: description || searchable,
          parameters: schema,
          sources: [...new Set(sources)],
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * What a model replay applies (RC-61), read from the same fix: crafted
 * definitions to offer, the tools that now fail clearly, a prerequisite, a
 * skill. Kinds a replay doesn't serve get no `replay` part.
 */
function replayOf(
  fix: Pick<Fix, "kind" | "title" | "short" | "subject" | "detail">,
  tools: readonly string[],
): ReplayChange | undefined {
  const replay: ReplayChange = { tools: [], failClearly: [], prerequisite: null, skill: null };
  const detail = fix.detail;
  if (detail.source === "craft") {
    const sourceIds = new Set(detail.sources.map((source) => source.id));
    for (const crafted of detail.crafted
      .map((tool) => parseCrafted(tool.json))
      .filter((tool): tool is CraftedJson => tool !== null)) {
      const steps =
        crafted.sources.length > 0 ? crafted.sources : detail.sources.map((source) => source.id);
      let replaces: string[];
      if (sourceIds.has(crafted.name))
        replaces = []; // the same tool with a new definition (a schema, a rewrite)
      else if (fix.kind === "prerequisite")
        replaces = steps.slice(-1); // the dependent tool; the prerequisite stays callable
      else if (fix.kind === "schema") replaces = steps.slice(0, 1);
      else replaces = steps;
      const def: CraftedToolDef = {
        name: crafted.name,
        description: crafted.description,
        parameters: crafted.parameters,
        replaces,
      };
      replay.tools.push(def);
      if (fix.kind === "prerequisite" && steps.length >= 2)
        replay.prerequisite = { before: steps[0]!, tool: steps[steps.length - 1]! };
    }
    if (fix.kind === "prerequisite" && !replay.prerequisite && tools.length >= 2)
      replay.prerequisite = { before: tools[0]!, tool: tools[tools.length - 1]! };
  }
  if (fix.kind === "prerequisite" && detail.source !== "craft" && tools.length >= 2)
    replay.prerequisite = { before: tools[0]!, tool: tools[tools.length - 1]! };
  if (fix.kind === "fail-clearly") replay.failClearly = [...tools];
  if (fix.kind === "skill") {
    const steps = detail.source === "intent" && detail.steps.length > 0 ? detail.steps : [...tools];
    if (steps.length > 0)
      replay.skill = { name: fix.short || fix.title, steps: [...new Set(steps)] };
  }
  const any =
    replay.tools.length > 0 ||
    replay.failClearly.length > 0 ||
    replay.prerequisite !== null ||
    replay.skill !== null;
  return any ? replay : undefined;
}

/** "Return 3 results per search instead of 10" → 3. */
export function topKFromTitle(title: string): number | null {
  const match = /\breturn (\d+) results?\b/i.exec(title);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function changeOf(
  fix: Pick<Fix, "kind" | "title" | "subject" | "detail"> & Partial<Pick<Fix, "short">>,
  draft?: FixChange | null,
): FixChange {
  if (draft && hasEffect(draft)) return draft;
  const change = emptyChange();
  const tools = fix.subject.tools.map((tool) => tool.id);
  const unsupported = UNSUPPORTED[fix.kind];
  if (unsupported) return { ...change, unsupportedReason: unsupported };
  const replay = replayOf({ ...fix, short: fix.short ?? fix.title }, tools);
  if (replay) change.replay = replay;

  const detail = fix.detail;
  if (detail.source === "rewrite") {
    const entry = detail.row.toolId || tools[0];
    if (entry && detail.row.proposed.trim()) change.patches[entry] = detail.row.proposed.trim();
  }
  if (detail.source === "craft") {
    const byName = new Map(detail.sources.map((source) => [source.name, source.id]));
    const added: AddedTool[] = [];
    for (const crafted of detail.crafted
      .map((tool) => parseCrafted(tool.json))
      .filter((tool): tool is CraftedJson => tool !== null)) {
      const same = byName.get(crafted.name);
      if (same) change.patches[same] = crafted.searchable;
      else
        added.push({
          id: crafted.name,
          name: crafted.name,
          searchable: crafted.searchable,
          replaces: detail.sources.map((source) => source.id),
        });
    }
    // A merged tool stands in for its sources: they leave every list it joins.
    if (fix.kind === "merge" || fix.kind === "combine") {
      for (const tool of added)
        change.hide.push(...tool.replaces.filter((id) => !change.hide.includes(id)));
    }
    change.add = fix.kind === "merge" || fix.kind === "combine" ? added : [];
  }

  if (fix.kind === "retire") change.hide.push(...tools.filter((id) => !change.hide.includes(id)));
  if (COLLAPSING.has(fix.kind) && tools.length >= 1) change.collapse = tools;
  if (RETRYING.has(fix.kind)) change.dedupeRetries = tools;
  if (fix.kind === "fewer-results") change.topK = topKFromTitle(fix.title) ?? 3;
  if (fix.kind === "skill") {
    const steps = detail.source === "intent" && detail.steps.length > 0 ? detail.steps : tools;
    change.skillSteps = [...new Set(steps)];
  }

  if (!hasEffect(change)) {
    change.unsupportedReason =
      fix.kind === "rewrite" || fix.kind === "tell-apart"
        ? "There's no drafted text to replay yet. Run an analysis on Quality to draft one."
        : "This fix names no change the simulator can apply.";
  }
  return change;
}

export function hasEffect(change: FixChange): boolean {
  return (
    Object.keys(change.patches).length > 0 ||
    change.hide.length > 0 ||
    change.add.length > 0 ||
    change.collapse.length > 0 ||
    change.dedupeRetries.length > 0 ||
    change.topK !== null ||
    change.skillSteps.length > 0
  );
}

/** A stored change read back strictly; anything malformed becomes "nothing to apply". */
export function parseChange(value: unknown): FixChange {
  const base = emptyChange();
  if (!value || typeof value !== "object")
    return { ...base, unsupportedReason: "This eval set has no change to apply." };
  const record = value as Record<string, unknown>;
  const strings = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  const patches: Record<string, string> = {};
  if (record.patches && typeof record.patches === "object") {
    for (const [key, text] of Object.entries(record.patches as Record<string, unknown>))
      if (typeof text === "string") patches[key] = text;
  }
  const add = Array.isArray(record.add)
    ? record.add.flatMap((raw): AddedTool[] => {
        if (!raw || typeof raw !== "object") return [];
        const tool = raw as Record<string, unknown>;
        if (
          typeof tool.id !== "string" ||
          typeof tool.name !== "string" ||
          typeof tool.searchable !== "string"
        )
          return [];
        return [
          {
            id: tool.id,
            name: tool.name,
            searchable: tool.searchable,
            replaces: strings(tool.replaces),
          },
        ];
      })
    : [];
  return {
    version: 1,
    patches,
    hide: strings(record.hide),
    add,
    collapse: strings(record.collapse),
    dedupeRetries: strings(record.dedupeRetries),
    topK: typeof record.topK === "number" && record.topK > 0 ? Math.floor(record.topK) : null,
    skillSteps: strings(record.skillSteps),
    unsupportedReason:
      typeof record.unsupportedReason === "string" ? record.unsupportedReason : null,
    ...(parseReplay(record.replay) ? { replay: parseReplay(record.replay)! } : {}),
  };
}

function parseReplay(value: unknown): ReplayChange | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const strings = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  const tools = Array.isArray(record.tools)
    ? record.tools.flatMap((raw): CraftedToolDef[] => {
        if (!raw || typeof raw !== "object") return [];
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== "string" || typeof tool.description !== "string") return [];
        const parameters =
          tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
            ? (tool.parameters as Record<string, unknown>)
            : { type: "object", properties: {} };
        return [
          {
            name: tool.name,
            description: tool.description,
            parameters,
            replaces: strings(tool.replaces),
          },
        ];
      })
    : [];
  const pre =
    record.prerequisite && typeof record.prerequisite === "object"
      ? (record.prerequisite as Record<string, unknown>)
      : null;
  const skill =
    record.skill && typeof record.skill === "object"
      ? (record.skill as Record<string, unknown>)
      : null;
  return {
    tools,
    failClearly: strings(record.failClearly),
    prerequisite:
      pre && typeof pre.before === "string" && typeof pre.tool === "string"
        ? { before: pre.before, tool: pre.tool }
        : null,
    skill:
      skill && typeof skill.name === "string"
        ? { name: skill.name, steps: strings(skill.steps) }
        : null,
  };
}

/** The change in plain words, one line each, for the eval page. */
export function describeChange(
  change: FixChange,
  names: ReadonlyMap<string, string> = new Map(),
): string[] {
  const name = (id: string) => names.get(id) ?? id;
  const lines: string[] = [];
  for (const entry of Object.keys(change.patches))
    lines.push(
      `${name(entry)}'s searchable description is replaced, and every readable search is ranked again.`,
    );
  for (const tool of change.add)
    lines.push(
      `${tool.name} joins the catalog in place of ${tool.replaces.map(name).join(" and ")}.`,
    );
  const hiddenAlone = change.hide.filter(
    (id) => !change.add.some((tool) => tool.replaces.includes(id)),
  );
  if (hiddenAlone.length > 0)
    lines.push(
      `${hiddenAlone.map(name).join(", ")} ${hiddenAlone.length === 1 ? "leaves" : "leave"} every list.`,
    );
  if (change.collapse.length > 0)
    lines.push(`Back-to-back calls to ${change.collapse.map(name).join(", ")} become one call.`);
  if (change.dedupeRetries.length > 0)
    lines.push(`A failed call to ${change.dedupeRetries.map(name).join(", ")} is not retried.`);
  if (change.topK !== null) lines.push(`Every list is cut to ${change.topK} results.`);
  if (change.skillSteps.length > 0)
    lines.push(
      `A skill hands over ${change.skillSteps.map(name).join(", ")}, so the searches to reach them drop.`,
    );
  return lines;
}

/** What a model replay applies, in plain words (RC-61). */
export function describeReplay(
  change: FixChange,
  names: ReadonlyMap<string, string> = new Map(),
): string[] {
  const name = (id: string) => names.get(id) ?? id;
  const replay = change.replay;
  if (!replay) return [];
  const lines: string[] = [];
  for (const tool of replay.tools) {
    lines.push(
      tool.replaces.length > 0
        ? `The model is offered ${tool.name} in place of ${tool.replaces.map(name).join(" and ")}.`
        : `The model is offered ${name(tool.name)}'s new definition.`,
    );
  }
  if (replay.failClearly.length > 0)
    lines.push(
      `When ${replay.failClearly.map(name).join(", ")} fails, the model is told why and that retrying won't help.`,
    );
  if (replay.prerequisite)
    lines.push(
      `${name(replay.prerequisite.tool)} says to run ${name(replay.prerequisite.before)} first.`,
    );
  if (replay.skill)
    lines.push(
      `The model is handed a skill with the steps ${replay.skill.steps.map(name).join(", then ")}.`,
    );
  return lines;
}
