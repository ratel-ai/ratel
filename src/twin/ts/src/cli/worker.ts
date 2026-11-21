import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TwinParamError } from "../errors.js";
import { buildManifest } from "../manifest.js";
import { coerceOverride } from "../params.js";
import { runTwin } from "../run.js";
import { isTwin, type Twin } from "../twin.js";
import type { WorkerReply, WorkerRequest } from "./messages.js";

// The child process of the `ratel` CLI. It is the only process that loads user
// code and the project's .env. It answers one request over IPC, then exits.

process.once("message", (request: WorkerRequest) => {
  handle(request)
    .catch((err: unknown): WorkerReply => ({ ok: false, error: messageOf(err) }))
    .then((reply) => process.send?.(reply, () => process.exit(0)));
});

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  const envFile = join(request.root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const twins = await loadTwins(request.root, request.files);
  if (request.kind === "list") {
    return {
      ok: true,
      kind: "list",
      manifest: buildManifest({ twins, build: request.build, env: process.env }),
    };
  }
  const found = twins.find(({ twin }) => twin.id === request.twinId)?.twin;
  if (!found) {
    const known = twins.map(({ twin }) => twin.id).join(", ") || "(none)";
    return { ok: false, error: `unknown twin "${request.twinId}". Known twins: ${known}` };
  }
  const overrides = coerceSets(found, request.sets);
  try {
    const result = await runTwin(found, { input: request.input, overrides });
    return {
      ok: true,
      kind: "run",
      output: result.output,
      configHash: result.configHash,
      overrides: result.overrides,
    };
  } catch (err) {
    if (err instanceof TwinParamError) throw err;
    throw new Error(`${found.id}: run() threw: ${messageOf(err)}`);
  }
}

async function loadTwins(
  root: string,
  files: readonly string[],
): Promise<{ twin: Twin; file: string }[]> {
  const twins: { twin: Twin; file: string }[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(join(root, file)).href);
    } catch (err) {
      throw new Error(`cannot load ${file}: ${messageOf(err)}`);
    }
    for (const value of new Set(Object.values(mod))) {
      if (!isTwin(value)) continue;
      const clash = twins.find(({ twin }) => twin.id === value.id);
      if (clash)
        throw new Error(`twin id "${value.id}" is declared in both ${clash.file} and ${file}`);
      twins.push({ twin: value, file });
    }
  }
  return twins;
}

function coerceSets(
  twin: Twin,
  sets: readonly (readonly [string, string])[],
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const [name, raw] of sets) {
    const param = Object.hasOwn(twin.params, name) ? twin.params[name] : undefined;
    overrides[name] = param ? coerceOverride(param, raw) : raw;
  }
  return overrides;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
