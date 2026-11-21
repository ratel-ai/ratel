import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelResolutionError, TwinInputError, TwinParamError } from "../errors.js";
import { buildManifest } from "../manifest.js";
import { coerceOverride } from "../params.js";
import { runTwin } from "../run.js";
import { ToolModeError } from "../tools.js";
import type { Twin } from "../twin.js";
import { loadTwins, messageOf } from "./load.js";
import { localToolChannel } from "./local-tools.js";
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
      manifest: buildManifest({
        twins,
        build: request.build,
        env: process.env,
        root: request.root,
      }),
    };
  }
  const loaded = twins.find(({ twin }) => twin.id === request.twinId);
  const found = loaded?.twin;
  if (!found || !loaded) {
    const known = twins.map(({ twin }) => twin.id).join(", ") || "(none)";
    return { ok: false, error: `unknown twin "${request.twinId}". Known twins: ${known}` };
  }
  const overrides = coerceSets(found, request.sets);
  try {
    // A chat twin streams its reply: show it as it comes, on stderr, so stdout keeps only the result.
    const result = await runTwin(found, {
      input: request.input,
      overrides,
      // The resolver imports `ai` and the providers from the twin file's project.
      resolveContext: { from: join(request.root, loaded.file) },
      onText: (text) => process.stderr.write(text),
      toolModes: request.tools,
      toolChannel: localToolChannel(
        found,
        request.fakes,
        (line) => process.stderr.write(`${line}\n`),
        { from: join(request.root, loaded.file) },
      ),
      onEvent: (event) => {
        if (event.kind === "tool.call") process.stderr.write(`\n[${event.tool} ${event.mode}] `);
        if (event.kind === "tool.result")
          process.stderr.write(`${JSON.stringify(event.result)?.slice(0, 200)}\n`);
      },
    });
    return {
      ok: true,
      kind: "run",
      output: result.output,
      configHash: result.configHash,
      overrides: result.overrides,
      toolModes: result.toolModes,
    };
  } catch (err) {
    if (
      err instanceof TwinParamError ||
      err instanceof TwinInputError ||
      err instanceof ModelResolutionError ||
      err instanceof ToolModeError
    )
      throw err;
    throw new Error(`${found.id}: run() threw: ${messageOf(err)}`);
  }
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
