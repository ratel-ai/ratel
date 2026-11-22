import {
  type ParamMap,
  resolveParams,
  resolveToolModes,
  type Sandbox,
  SandboxParamError,
  ToolModeError,
} from "@ratel-ai/sandbox";
import { Ajv } from "ajv";
import { manifestTools } from "./tools-state";

/**
 * Server-side checks of a playground run request against the runner's
 * manifest (spec §2 rule 2: Ratel sends plain data, checked against the
 * manifest). Param overrides go through the SDK's own `resolveParams`, so the
 * rules and the config hash are the ones the runner and production use.
 */

export interface ManifestSandboxView {
  id: string;
  input: { kind: "structured"; schema: Record<string, unknown> } | { kind: "chat" };
  params: ({ name: string } & Record<string, unknown>)[];
}

export type RunRequestCheck =
  | { ok: true; configHash: string; overrides: string[] }
  | { ok: false; error: "unknown_sandbox" }
  | { ok: false; error: "invalid_params"; params: { param: string; message: string }[] }
  | { ok: false; error: "invalid_input"; message: string }
  | { ok: false; error: "invalid_tool_modes"; problems: string[] };

/** The sandbox of this id in a runner manifest, or null. */
export function findManifestSandbox(
  manifest: Record<string, unknown>,
  sandboxId: string,
): ManifestSandboxView | null {
  const sandboxes = Array.isArray(manifest.sandboxes)
    ? (manifest.sandboxes as ManifestSandboxView[])
    : [];
  return sandboxes.find((t) => t?.id === sandboxId) ?? null;
}

export function checkRunRequest(
  sandbox: ManifestSandboxView | null,
  input: unknown,
  overrides: Record<string, unknown>,
  toolModes: Record<string, string> = {},
): RunRequestCheck {
  if (!sandbox) return { ok: false, error: "unknown_sandbox" };
  // The runner's own rule: a sideEffect tool runs real only with allowReal in the sandbox file.
  try {
    resolveToolModes(sandbox.id, manifestTools(sandbox), toolModes);
  } catch (err) {
    if (err instanceof ToolModeError)
      return { ok: false, error: "invalid_tool_modes", problems: [...err.problems] };
    throw err;
  }
  let resolved: { configHash: string; overrides: readonly string[] };
  try {
    resolved = resolveManifestParams(sandbox, overrides);
  } catch (err) {
    if (err instanceof SandboxParamError)
      return { ok: false, error: "invalid_params", params: err.errors.map((e) => ({ ...e })) };
    throw err;
  }
  const inputProblem = checkInput(sandbox, input);
  if (inputProblem) return { ok: false, error: "invalid_input", message: inputProblem };
  return { ok: true, configHash: resolved.configHash, overrides: [...resolved.overrides] };
}

/**
 * The config hash of the sandbox's code defaults: the hash a run with no edits
 * gets. Null when the manifest's own defaults do not resolve.
 */
export function defaultConfigHash(sandbox: ManifestSandboxView): string | null {
  try {
    return resolveManifestParams(sandbox, {}).configHash;
  } catch (err) {
    if (err instanceof SandboxParamError) return null;
    throw err;
  }
}

function resolveManifestParams(sandbox: ManifestSandboxView, overrides: Record<string, unknown>) {
  const params = Object.fromEntries(
    sandbox.params.map(({ name, ...param }) => [name, param]),
  ) as unknown as ParamMap;
  return resolveParams({ id: sandbox.id, params } as unknown as Sandbox, overrides);
}

function checkInput(sandbox: ManifestSandboxView, input: unknown): string | null {
  if (sandbox.input.kind === "chat") {
    const messages = (input as { messages?: unknown } | null)?.messages;
    return Array.isArray(messages) && messages.length > 0
      ? null
      : "input.messages must be a non-empty list";
  }
  // A fresh validator per check: each request brings its own schema object,
  // and one shared Ajv would cache every one of them for the process lifetime.
  const validate = new Ajv({ allErrors: false, strict: false }).compile(sandbox.input.schema);
  if (validate(input)) return null;
  const first = validate.errors?.[0];
  return first ? `input${first.instancePath} ${first.message ?? "is invalid"}` : "input is invalid";
}
