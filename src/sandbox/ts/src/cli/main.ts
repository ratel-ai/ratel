#!/usr/bin/env node
import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_BASE_URL, startDev } from "../dev/runtime.js";
import { CliError, type Command, parseArgs, USAGE } from "./args.js";
import { buildInfo } from "./build-info.js";
import { discoverSandboxFiles } from "./discover.js";
import { formatManifest, formatRun, formatVerify } from "./format.js";
import type { WorkerReply, WorkerRequest } from "./messages.js";

// The `ratel` CLI parent. It never loads user code: discovery reads file names
// only, and a child worker (worker.ts, or dev/child.ts for `ratel sandbox dev`, under
// tsx) imports the sandboxes and runs them.

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`ratel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

async function main(argv: readonly string[]): Promise<number> {
  const command = parseArgs(argv);
  if (command.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = process.cwd();
  if (command.command === "dev") {
    if (command.deprecatedAlias)
      process.stderr.write("ratel: `ratel dev` is deprecated, use `ratel sandbox dev`\n");
    return devCommand(command, root);
  }
  const files = discoverSandboxFiles(root);
  if (command.command === "list") {
    const reply = await askWorker({ kind: "list", root, files, build: buildInfo(root, files) });
    if (reply.kind !== "list") throw new Error("the sandbox worker answered the wrong request");
    process.stdout.write(
      command.json
        ? `${JSON.stringify(reply.manifest, null, 2)}\n`
        : formatManifest(reply.manifest),
    );
    return 0;
  }
  if (command.command === "verify") return verifyCommand(command, root, files);
  return runCommand(command, root, files);
}

/** `ratel sandbox verify`: exits 1 when a param is not wired. */
async function verifyCommand(
  command: Extract<Command, { command: "verify" }>,
  root: string,
  files: string[],
): Promise<number> {
  process.stderr.write(
    command.dry
      ? `Verifying ${command.sandboxId} with a stand-in model (--dry): AI SDK models make no call.\n`
      : `Verifying ${command.sandboxId}: it runs the sandbox once per param and calls its model with your own keys. Use --dry for a stand-in model.\n`,
  );
  const reply = await askWorker({
    kind: "verify",
    root,
    files,
    sandboxId: command.sandboxId,
    dry: command.dry,
    ...(command.input !== undefined ? { input: readJson("--input", command.input) } : {}),
    ...(command.model !== undefined ? { model: command.model } : {}),
  });
  if (reply.kind !== "verify") throw new Error("the sandbox worker answered the wrong request");
  process.stdout.write(formatVerify(reply.report));
  return reply.report.ok ? 0 : 1;
}

/** `ratel sandbox dev`: runs until Ctrl-C. Exits 1 on a fatal connection error (bad key, sandboxes off). */
async function devCommand(
  command: Extract<Command, { command: "dev" }>,
  root: string,
): Promise<number> {
  const env = { ...readRatelEnv(root), ...pickRatelEnv(process.env) };
  const apiKey = env.RATEL_API_KEY;
  if (!apiKey) throw new CliError("set RATEL_API_KEY to a Ratel project key (rtl_...)");
  const handle = await startDev({
    root,
    baseUrl: command.url ?? env.RATEL_URL ?? DEFAULT_BASE_URL,
    apiKey,
    out: (line) => process.stdout.write(`${line}\n`),
  });
  const stop = () => handle.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await handle.done;
  return 0;
}

/**
 * RATEL_API_KEY and RATEL_URL from the project's .env. The parent reads these
 * two names only and never loads the rest of the file: provider keys stay in
 * the child worker.
 */
function readRatelEnv(root: string): RatelEnv {
  const file = join(root, ".env");
  if (!existsSync(file)) return {};
  return pickRatelEnv(parseEnv(readFileSync(file, "utf8")));
}

type RatelEnv = { RATEL_API_KEY?: string; RATEL_URL?: string };

function pickRatelEnv(env: Readonly<Record<string, string | undefined>>): RatelEnv {
  return {
    ...(env.RATEL_API_KEY ? { RATEL_API_KEY: env.RATEL_API_KEY } : {}),
    ...(env.RATEL_URL ? { RATEL_URL: env.RATEL_URL } : {}),
  };
}

async function runCommand(
  command: Extract<Command, { command: "run" }>,
  root: string,
  files: string[],
): Promise<number> {
  const input = readJson("--input", command.input);
  const reply = await askWorker({
    kind: "run",
    root,
    files,
    sandboxId: command.sandboxId,
    input,
    sets: command.sets,
    tools: command.tools,
    fakes: Object.fromEntries(
      Object.entries(command.fakes).map(([tool, file]) => [tool, readJson("--fake", file)]),
    ),
  });
  if (reply.kind !== "run") throw new Error("the sandbox worker answered the wrong request");
  process.stdout.write(
    formatRun({ sandboxId: command.sandboxId, tools: reply.toolModes, ...reply }),
  );
  return 0;
}

function readJson(flag: string, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(
      `cannot read ${flag} ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${flag} ${path} is not valid JSON`);
  }
}

/** Forks one worker under tsx, sends it one request and resolves with its reply. */
function askWorker(request: WorkerRequest): Promise<Extract<WorkerReply, { ok: true }>> {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = fork(fileURLToPath(new URL(`./worker.${ext}`, import.meta.url)), [], {
    cwd: request.root,
    execArgv: ["--import", import.meta.resolve("tsx")],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let replied = false;
    worker.once("message", (reply: WorkerReply) => {
      replied = true;
      if (reply.ok) resolve(reply);
      else reject(new CliError(reply.error));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!replied)
        reject(new Error(`the sandbox worker exited with code ${code} before it answered`));
    });
    worker.send(request);
  });
}
