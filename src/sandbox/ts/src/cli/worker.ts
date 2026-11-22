import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelResolutionError, SandboxInputError, SandboxParamError } from "../errors.js";
import { buildManifest } from "../manifest.js";
import { coerceOverride } from "../params.js";
import { runSandbox } from "../run.js";
import type { Sandbox } from "../sandbox.js";
import { ToolModeError } from "../tools.js";
import { verifySandbox } from "../verify.js";
import { installVerifyTracing, type VerifyTracing } from "../verify-tracing.js";
import { dryToolChannel } from "./dry-tools.js";
import { type LoadedSandbox, loadSandboxes, messageOf } from "./load.js";
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
  // Before any project code loads: verify spans stay in memory, never exported.
  const tracing = request.kind === "verify" ? installVerifyTracing() : undefined;
  const sandboxes = await loadSandboxes(request.root, request.files);
  if (request.kind === "list") {
    return {
      ok: true,
      kind: "list",
      manifest: buildManifest({
        sandboxes,
        build: request.build,
        env: process.env,
        root: request.root,
      }),
    };
  }
  const loaded = sandboxes.find(({ sandbox }) => sandbox.id === request.sandboxId);
  const found = loaded?.sandbox;
  if (!found || !loaded) {
    const known = sandboxes.map(({ sandbox }) => sandbox.id).join(", ") || "(none)";
    return {
      ok: false,
      error: `unknown sandbox "${request.sandboxId}". Known sandboxes: ${known}`,
    };
  }
  if (request.kind === "verify") return verify(request, loaded, tracing as VerifyTracing);
  const overrides = coerceSets(found, request.sets);
  try {
    // A chat sandbox streams its reply: show it as it comes, on stderr, so stdout keeps only the result.
    const result = await runSandbox(found, {
      input: request.input,
      overrides,
      // The resolver imports `ai` and the providers from the sandbox file's project.
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
      err instanceof SandboxParamError ||
      err instanceof SandboxInputError ||
      err instanceof ModelResolutionError ||
      err instanceof ToolModeError
    )
      throw err;
    throw new Error(`${found.id}: run() threw: ${messageOf(err)}`);
  }
}

async function verify(
  request: Extract<WorkerRequest, { kind: "verify" }>,
  loaded: LoadedSandbox,
  tracing: VerifyTracing,
): Promise<WorkerReply> {
  const { sandbox } = loaded;
  const input = request.input ?? sandbox.example;
  if (input === undefined)
    return {
      ok: false,
      error: `${sandbox.id}: verify needs an input: pass --input <file>, or add \`example\` to the sandbox`,
    };
  const from = join(request.root, loaded.file);
  const note = (line: string) => process.stderr.write(`${line}\n`);
  if (request.dry && sandbox.resolve?.modelKind !== "language-model")
    note(`--dry: ${sandbox.id} calls its model with its own client, so its calls are real`);
  let n = 0;
  const report = await verifySandbox(sandbox, {
    input,
    spans: tracing,
    dry: request.dry,
    resolveContext: { from },
    toolChannel: request.dry ? dryToolChannel() : localToolChannel(sandbox, {}, note, { from }),
    onRun: (label) => note(`  run ${++n}: ${label}`),
    ...(request.model ? { model: request.model } : {}),
  });
  await tracing.shutdown();
  return { ok: true, kind: "verify", report };
}

function coerceSets(
  sandbox: Sandbox,
  sets: readonly (readonly [string, string])[],
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const [name, raw] of sets) {
    const param = Object.hasOwn(sandbox.params, name) ? sandbox.params[name] : undefined;
    overrides[name] = param ? coerceOverride(param, raw) : raw;
  }
  return overrides;
}
