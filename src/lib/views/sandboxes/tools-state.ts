/**
 * The playground's tool rules (spec §3.6, §9), pure so the Tools panel, the
 * tool cards and the run API share them: the tools of a manifest sandbox, the
 * modes each tool may take, the tools override a run sends, and the badge of
 * a tool call.
 */

export type ToolMode = "real" | "fake" | "confirm";
export type ToolHint = "readOnly" | "sideEffect" | "none";

/** A tool as the manifest lists it (`@ratel-ai/sandbox` ToolDescriptor, plain JSON). */
export interface ManifestTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  hint: ToolHint;
  allowReal?: boolean;
  opaque?: boolean;
  /** The tools param that declares it. */
  param: string;
}

/** What the reviewer set for one tool in the panel. Absent fields keep the code's value. */
export interface ToolSetting {
  enabled?: boolean;
  description?: string;
  mode?: ToolMode;
}

export type ToolBadge =
  | "real"
  | "fake·recorded"
  | "fake·generated"
  | "fake·pinned"
  | "confirmed"
  | "rejected"
  | "pending"
  | "awaiting review";

/** A tool call as the card draws it (see `ToolCallView` in playground-state). */
export interface ToolCallBadgeInput {
  mode: string | null;
  done: boolean;
  fakeSource?: string | null;
  confirmDecision?: string | null;
}

const MODES: readonly ToolMode[] = ["real", "fake", "confirm"];

/** Every tool of the sandbox's tools params, in declaration order. */
export function manifestTools(sandbox: {
  params: readonly ({ name: string } & Record<string, unknown>)[];
}): ManifestTool[] {
  return sandbox.params
    .filter((param) => param.kind === "tools" && Array.isArray(param.default))
    .flatMap((param) =>
      (param.default as Record<string, unknown>[])
        .filter((tool) => typeof tool?.name === "string")
        .map((tool) => ({
          name: String(tool.name),
          description: typeof tool.description === "string" ? tool.description : "",
          ...(isObject(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
          ...(isObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
          hint: tool.hint === "readOnly" || tool.hint === "sideEffect" ? tool.hint : "none",
          ...(tool.allowReal === true ? { allowReal: true } : {}),
          ...(tool.opaque === true ? { opaque: true } : {}),
          param: param.name,
        })),
    );
}

/** The mode a tool runs in when the reviewer sets none: readOnly real, sideEffect fake, no hint confirm. */
export function defaultToolMode(tool: Pick<ManifestTool, "hint">): ToolMode {
  return tool.hint === "readOnly" ? "real" : tool.hint === "sideEffect" ? "fake" : "confirm";
}

/** The modes the panel offers. A sideEffect tool runs real only when the sandbox file says allowReal. */
export function allowedToolModes(tool: Pick<ManifestTool, "hint" | "allowReal">): ToolMode[] {
  return MODES.filter(
    (mode) => mode !== "real" || tool.hint !== "sideEffect" || tool.allowReal === true,
  );
}

/** The `toolModes` of a run: only the modes that differ from the default and are allowed. */
export function toolModesFor(
  tools: readonly ManifestTool[],
  settings: Readonly<Record<string, ToolSetting>>,
): Record<string, ToolMode> {
  const modes: Record<string, ToolMode> = {};
  for (const tool of tools) {
    const mode = settings[tool.name]?.mode;
    if (mode && mode !== defaultToolMode(tool) && allowedToolModes(tool).includes(mode))
      modes[tool.name] = mode;
  }
  return modes;
}

/**
 * The param overrides of the tools params, in the SDK's form: per param, the
 * full list of its tools (`{ name, description?, enabled? }[]`). The SDK drops
 * a tool the list leaves out, so a changed param lists every tool, with an edit
 * only on the changed ones. A param with no change is left out: the code's default.
 */
export function toolsParamOverrides(
  tools: readonly ManifestTool[],
  settings: Readonly<Record<string, ToolSetting>>,
): Record<string, unknown> {
  const byParam: Record<
    string,
    { edits: { name: string; description?: string; enabled?: boolean }[]; changed: boolean }
  > = {};
  for (const tool of tools) {
    const setting = settings[tool.name];
    const edit: { name: string; description?: string; enabled?: boolean } = { name: tool.name };
    if (setting?.description !== undefined && setting.description !== tool.description)
      edit.description = setting.description;
    if (setting?.enabled === false) edit.enabled = false;
    const entry = (byParam[tool.param] ??= { edits: [], changed: false });
    entry.edits.push(edit);
    if (Object.keys(edit).length > 1) entry.changed = true;
  }
  return Object.fromEntries(
    Object.entries(byParam)
      .filter(([, entry]) => entry.changed)
      .map(([param, entry]) => [param, entry.edits]),
  );
}

/** The badge of a tool call card. */
export function toolBadge(call: ToolCallBadgeInput): ToolBadge {
  if (!call.done) return call.mode === "confirm" ? "awaiting review" : "pending";
  if (call.confirmDecision === "approve" || call.confirmDecision === "edit") return "confirmed";
  if (call.confirmDecision === "reject") return "rejected";
  if (call.fakeSource === "recorded") return "fake·recorded";
  if (call.fakeSource === "generated") return "fake·generated";
  if (call.fakeSource === "pinned") return "fake·pinned";
  return "real";
}

/** Whether "Pin this result" applies: a finished fake the reviewer may keep for the same arguments. */
export function canPin(call: ToolCallBadgeInput & { isError?: boolean }): boolean {
  return (
    call.done &&
    (call.fakeSource === "recorded" || call.fakeSource === "generated") &&
    call.isError !== true
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
