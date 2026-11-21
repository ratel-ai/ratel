export type ToolMode = "real" | "fake" | "confirm";

export type Command =
  | { readonly command: "help" }
  | { readonly command: "list"; readonly json: boolean }
  | { readonly command: "dev"; readonly url?: string }
  | {
      readonly command: "run";
      readonly twinId: string;
      readonly input: string;
      readonly sets: readonly (readonly [name: string, raw: string])[];
      readonly tools: Readonly<Record<string, ToolMode>>;
    };

/** A usage error: printed as one line, no stack. */
export class CliError extends Error {
  override readonly name = "CliError";
}

export const USAGE = `Usage:
  ratel dev [--url <ratel url>]
  ratel twin list [--json]
  ratel twin run <id> --input <file> [--set name=value]... [--tool name=real|fake|confirm]...`;

const TOOL_MODES: readonly ToolMode[] = ["real", "fake", "confirm"];

/** Parses `ratel` argv (without node and the script). Throws CliError on bad usage. */
export function parseArgs(argv: readonly string[]): Command {
  const [group, sub, ...rest] = argv;
  if (group === undefined || group === "help" || group === "--help" || group === "-h")
    return { command: "help" };
  if (group === "dev") return parseDev(argv.slice(1));
  if (group === "twin" && sub === "list") return parseList(rest);
  if (group === "twin" && sub === "run") return parseRun(rest);
  throw new CliError(`unknown command "${[group, sub].filter(Boolean).join(" ")}"\n${USAGE}`);
}

function parseDev(rest: readonly string[]): Command {
  let url: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg !== "--url") throw new CliError(`unknown option ${arg} for "dev"`);
    url = rest[++i];
    if (url === undefined) throw new CliError("--url needs a value");
  }
  return url === undefined ? { command: "dev" } : { command: "dev", url };
}

function parseList(rest: readonly string[]): Command {
  for (const arg of rest)
    if (arg !== "--json") throw new CliError(`unknown option ${arg} for "twin list"`);
  return { command: "list", json: rest.includes("--json") };
}

function parseRun(rest: readonly string[]): Command {
  let twinId: string | undefined;
  let input: string | undefined;
  const sets: [string, string][] = [];
  const tools: Record<string, ToolMode> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--input" || arg === "--set" || arg === "--tool") {
      const value = rest[++i];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      if (arg === "--input") input = value;
      else if (arg === "--set") sets.push(splitPair(arg, value));
      else {
        const [tool, mode] = splitPair(arg, value);
        if (!TOOL_MODES.includes(mode as ToolMode)) {
          throw new CliError(`--tool ${value}: mode must be real, fake or confirm`);
        }
        tools[tool] = mode as ToolMode;
      }
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown option ${arg} for "twin run"`);
    } else if (twinId === undefined) {
      twinId = arg;
    } else {
      throw new CliError(`unexpected argument "${arg}"`);
    }
  }
  if (twinId === undefined) throw new CliError(`a twin id is required\n${USAGE}`);
  if (input === undefined) throw new CliError(`--input <file> is required\n${USAGE}`);
  return { command: "run", twinId, input, sets, tools };
}

function splitPair(flag: string, value: string): [string, string] {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new CliError(`${flag} ${value}: expected name=value`);
  return [value.slice(0, eq), value.slice(eq + 1)];
}
