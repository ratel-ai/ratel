#!/usr/bin/env node
import { execFileSync, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../manifest.js";
import { CliError, type Command, parseArgs, USAGE } from "./args.js";
import { discoverTwinFiles } from "./discover.js";
import { formatManifest, formatRun } from "./format.js";
import type { WorkerReply, WorkerRequest } from "./messages.js";

// The `ratel` CLI parent. It never loads user code: discovery reads file names
// only, and a child worker (worker.ts, under tsx) imports the twins and runs them.

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
  const files = discoverTwinFiles(root);
  if (command.command === "list") {
    const reply = await askWorker({ kind: "list", root, files, build: buildInfo(root) });
    if (reply.kind !== "list") throw new Error("the twin worker answered the wrong request");
    process.stdout.write(
      command.json
        ? `${JSON.stringify(reply.manifest, null, 2)}\n`
        : formatManifest(reply.manifest),
    );
    return 0;
  }
  return runCommand(command, root, files);
}

async function runCommand(
  command: Extract<Command, { command: "run" }>,
  root: string,
  files: string[],
): Promise<number> {
  const input = readInput(command.input);
  const reply = await askWorker({
    kind: "run",
    root,
    files,
    twinId: command.twinId,
    input,
    sets: command.sets,
    tools: command.tools,
  });
  if (reply.kind !== "run") throw new Error("the twin worker answered the wrong request");
  process.stdout.write(formatRun({ twinId: command.twinId, tools: command.tools, ...reply }));
  return 0;
}

function readInput(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(
      `cannot read --input ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`--input ${path} is not valid JSON`);
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
        reject(new Error(`the twin worker exited with code ${code} before it answered`));
    });
    worker.send(request);
  });
}

function buildInfo(root: string): Manifest["build"] {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { id: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return undefined;
  }
}
