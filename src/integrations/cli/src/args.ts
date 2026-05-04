export type Group = "mcp" | "backup" | "help";

export type McpVerb = "serve" | "add" | "remove" | "list" | "get" | "edit" | "import" | "link";

export type BackupVerb = "list" | "undo";

const MCP_VERBS: ReadonlySet<string> = new Set([
  "serve",
  "add",
  "remove",
  "list",
  "get",
  "edit",
  "import",
  "link",
]);

const BACKUP_VERBS: ReadonlySet<string> = new Set(["list", "undo"]);

const SHORT_FLAG_ALIASES: Record<string, string> = {
  e: "env",
};

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  group: Group;
  verb?: string;
  configPaths: string[];
  rest: string[];
  extras: string[];
  flags: Record<string, FlagValue>;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const configPaths: string[] = [];
  const rest: string[] = [];
  const extras: string[] = [];

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

  if (argv.length === 0) {
    return { group: "help", configPaths, rest, extras, flags };
  }

  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") {
    return { group: "help", configPaths, rest, extras, flags };
  }

  let group: Group;
  let verb: string | undefined;
  let i: number;

  if (first === "mcp") {
    group = "mcp";
    i = 1;
    if (argv.length > 1 && !argv[1].startsWith("-")) {
      const candidate = argv[1];
      if (!MCP_VERBS.has(candidate)) {
        throw new ArgError(`unknown mcp verb: ${candidate}`);
      }
      verb = candidate;
      i = 2;
    }
  } else if (first === "backup") {
    group = "backup";
    i = 1;
    if (argv.length > 1 && !argv[1].startsWith("-")) {
      const candidate = argv[1];
      if (!BACKUP_VERBS.has(candidate)) {
        throw new ArgError(`unknown backup verb: ${candidate}`);
      }
      verb = candidate;
      i = 2;
    }
  } else {
    throw new ArgError(`unknown command: ${first}`);
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
      extras.push(tok);
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
        if (key.startsWith("no-") && key.length > 3) {
          setFlag(key.slice(3), false);
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("-")) {
            setFlag(key, true);
          } else {
            setFlag(key, next);
            i++;
          }
        }
      }
      i++;
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      const short = tok.slice(1);
      const aliasKey = SHORT_FLAG_ALIASES[short];
      if (aliasKey) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          setFlag(aliasKey, true);
        } else {
          setFlag(aliasKey, next);
          i++;
        }
        i++;
        continue;
      }
      rest.push(tok);
      i++;
      continue;
    }

    if (group === "mcp" && verb === "serve") {
      configPaths.push(tok);
    } else {
      rest.push(tok);
    }
    i++;
  }

  return { group, verb, configPaths, rest, extras, flags };
}
