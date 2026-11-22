export type ToolMode = "real" | "fake" | "confirm";

export type Command =
  | { readonly command: "help" }
  | { readonly command: "list"; readonly json: boolean }
  | {
      readonly command: "dev";
      readonly url?: string;
      /** Set when called as the old `ratel dev`: main prints one deprecation line. */
      readonly deprecatedAlias?: true;
    }
  | {
      readonly command: "run";
      readonly sandboxId: string;
      readonly input: string;
      readonly sets: readonly (readonly [name: string, raw: string])[];
      readonly tools: Readonly<Record<string, ToolMode>>;
      /** A JSON file per tool whose content is its fake result. */
      readonly fakes: Readonly<Record<string, string>>;
      /** A stand-in model instead of real model calls, and fixed fakes (AI SDK sandboxes). */
      readonly dry?: true;
    }
  | {
      readonly command: "verify";
      readonly sandboxId: string;
      /** Absent: the sandbox's example input. */
      readonly input?: string;
      /** The second model of the model check. */
      readonly model?: string;
      /** A stand-in model instead of real model calls (AI SDK sandboxes). */
      readonly dry: boolean;
    }
  | { readonly command: "serve" }
  | {
      readonly command: "push";
      /** Absent: every discovered sandbox. */
      readonly sandboxId?: string;
      /** Write the bundle to a file and list it, without an upload. */
      readonly dryRun: boolean;
      /** Where --dry-run writes the bundle. */
      readonly out?: string;
      readonly url?: string;
    };

/** A usage error: printed as one line, no stack. */
export class CliError extends Error {
  override readonly name = "CliError";
}

export const USAGE = `Usage:
  ratel sandbox list [--json]
  ratel sandbox run <id> --input <file> [--set name=value]... [--tool name=real|fake|confirm]...
                       [--fake name=<file.json>]... [--dry]
  ratel sandbox verify <id> [--input <file>] [--model <provider/model>] [--dry]
  ratel sandbox push [<id>] [--dry-run [--out <file.tar.gz>]] [--url <ratel url>]
  ratel sandbox dev [--url <ratel url>]
  ratel sandbox serve   (container entrypoint: reads RATEL_INSTANCE_TOKEN and RATEL_GATEWAY_URL)`;

const TOOL_MODES: readonly ToolMode[] = ["real", "fake", "confirm"];

/** Parses `ratel` argv (without node and the script). Throws CliError on bad usage. */
export function parseArgs(argv: readonly string[]): Command {
  const [group, sub, ...rest] = argv;
  if (group === undefined || group === "help" || group === "--help" || group === "-h")
    return { command: "help" };
  // `ratel dev` is the old name of `ratel sandbox dev`: hidden, kept working.
  if (group === "dev") return { ...parseDev(argv.slice(1)), deprecatedAlias: true };
  if (group === "sandbox" && sub === "dev") return parseDev(rest);
  if (group === "sandbox" && sub === "list") return parseList(rest);
  if (group === "sandbox" && sub === "run") return parseRun(rest);
  if (group === "sandbox" && sub === "verify") return parseVerify(rest);
  if (group === "sandbox" && sub === "push") return parsePush(rest);
  if (group === "sandbox" && sub === "serve") {
    if (rest[0] !== undefined) throw new CliError(`unknown option ${rest[0]} for "sandbox serve"`);
    return { command: "serve" };
  }
  throw new CliError(`unknown command "${[group, sub].filter(Boolean).join(" ")}"\n${USAGE}`);
}

function parseDev(rest: readonly string[]): Extract<Command, { command: "dev" }> {
  let url: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg !== "--url") throw new CliError(`unknown option ${arg} for "sandbox dev"`);
    url = rest[++i];
    if (url === undefined) throw new CliError("--url needs a value");
  }
  return url === undefined ? { command: "dev" } : { command: "dev", url };
}

function parseList(rest: readonly string[]): Command {
  for (const arg of rest)
    if (arg !== "--json") throw new CliError(`unknown option ${arg} for "sandbox list"`);
  return { command: "list", json: rest.includes("--json") };
}

function parseRun(rest: readonly string[]): Command {
  let sandboxId: string | undefined;
  let input: string | undefined;
  const sets: [string, string][] = [];
  const tools: Record<string, ToolMode> = {};
  const fakes: Record<string, string> = {};
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--dry") dry = true;
    else if (arg === "--input" || arg === "--set" || arg === "--tool" || arg === "--fake") {
      const value = rest[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      if (arg === "--input") input = value;
      else if (arg === "--set") sets.push(splitPair(arg, value));
      else if (arg === "--fake") {
        const [tool, file] = splitPair(arg, value);
        fakes[tool] = file;
      } else {
        const [tool, mode] = splitPair(arg, value);
        if (!TOOL_MODES.includes(mode as ToolMode)) {
          throw new CliError(`--tool ${value}: mode must be real, fake or confirm`);
        }
        tools[tool] = mode as ToolMode;
      }
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown option ${arg} for "sandbox run"`);
    } else if (sandboxId === undefined) {
      sandboxId = arg;
    } else {
      throw new CliError(`unexpected argument "${arg}"`);
    }
  }
  if (sandboxId === undefined) throw new CliError(`a sandbox id is required\n${USAGE}`);
  if (input === undefined) throw new CliError(`--input <file> is required\n${USAGE}`);
  return { command: "run", sandboxId, input, sets, tools, fakes, ...(dry ? { dry: true } : {}) };
}

function parseVerify(rest: readonly string[]): Command {
  let sandboxId: string | undefined;
  let input: string | undefined;
  let model: string | undefined;
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--dry") dry = true;
    else if (arg === "--input" || arg === "--model") {
      const value = rest[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      if (arg === "--input") input = value;
      else model = value;
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown option ${arg} for "sandbox verify"`);
    } else if (sandboxId === undefined) {
      sandboxId = arg;
    } else {
      throw new CliError(`unexpected argument "${arg}"`);
    }
  }
  if (sandboxId === undefined) throw new CliError(`a sandbox id is required\n${USAGE}`);
  return {
    command: "verify",
    sandboxId,
    dry,
    ...(input !== undefined ? { input } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function parsePush(rest: readonly string[]): Command {
  let sandboxId: string | undefined;
  let out: string | undefined;
  let url: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--out" || arg === "--url") {
      const value = rest[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      if (arg === "--out") out = value;
      else url = value;
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown option ${arg} for "sandbox push"`);
    } else if (sandboxId === undefined) {
      sandboxId = arg;
    } else {
      throw new CliError(`unexpected argument "${arg}"`);
    }
  }
  if (out !== undefined && !dryRun) throw new CliError("--out works with --dry-run only");
  return {
    command: "push",
    dryRun,
    ...(sandboxId !== undefined ? { sandboxId } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function splitPair(flag: string, value: string): [string, string] {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new CliError(`${flag} ${value}: expected name=value`);
  return [value.slice(0, eq), value.slice(eq + 1)];
}
