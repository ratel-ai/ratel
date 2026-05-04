export type Subcommand =
  | "run"
  | "import"
  | "add"
  | "remove"
  | "edit"
  | "link"
  | "list"
  | "undo"
  | "help";

const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "import",
  "add",
  "remove",
  "edit",
  "link",
  "list",
  "undo",
  "help",
]);

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  subcommand: Subcommand;
  configPaths: string[];
  rest: string[];
  flags: Record<string, FlagValue>;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  let subcommand: Subcommand = "run";
  const configPaths: string[] = [];
  const rest: string[] = [];
  const flags: Record<string, FlagValue> = {};

  const setFlag = (key: string, value: string | boolean) => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
      return;
    }
    if (typeof value === "boolean" || typeof existing === "boolean") {
      flags[key] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }
    flags[key] = [existing, value];
  };

  let i = 0;

  if (argv.length > 0) {
    const first = argv[0];
    if (first === "--help" || first === "-h") {
      return { subcommand: "help", configPaths: [], rest: [], flags: {} };
    }
    if (KNOWN_SUBCOMMANDS.has(first)) {
      subcommand = first as Subcommand;
      i = 1;
    } else if (looksLikeSubcommandAttempt(first)) {
      throw new ArgError(`unknown subcommand: ${first}`);
    }
  }

  let stopFlags = false;

  while (i < argv.length) {
    const tok = argv[i];

    if (!stopFlags && tok === "--") {
      stopFlags = true;
      i++;
      continue;
    }

    if (stopFlags) {
      rest.push(tok);
      i++;
      continue;
    }

    if (tok === "--config" || tok.startsWith("--config=")) {
      const eq = tok.indexOf("=");
      let val: string | undefined;
      if (eq >= 0) {
        val = tok.slice(eq + 1);
      } else {
        val = argv[i + 1];
        if (val === undefined || val.startsWith("-")) {
          throw new ArgError("--config requires a value");
        }
        i++;
      }
      if (!val) throw new ArgError("--config requires a value");
      configPaths.push(val);
      i++;
      continue;
    }

    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        const key = tok.slice(2, eq);
        setFlag(key, tok.slice(eq + 1));
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          setFlag(key, true);
        } else {
          setFlag(key, next);
          i++;
        }
      }
      i++;
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      rest.push(tok);
      i++;
      continue;
    }

    if (subcommand === "run") {
      configPaths.push(tok);
    } else {
      rest.push(tok);
    }
    i++;
  }

  return { subcommand, configPaths, rest, flags };
}

function looksLikeSubcommandAttempt(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s);
}
