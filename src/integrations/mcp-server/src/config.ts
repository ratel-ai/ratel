export interface ServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  [k: string]: unknown;
}

export interface RatelConfig {
  mcpServers: Record<string, ServerEntry>;
}

export function parseConfig(input: unknown): RatelConfig {
  if (!isPlainObject(input)) {
    throw new ConfigError("root must be a JSON object");
  }
  const mcpServers = (input as Record<string, unknown>).mcpServers;
  if (!isPlainObject(mcpServers)) {
    throw new ConfigError("`mcpServers` must be a JSON object");
  }

  const out: Record<string, ServerEntry> = {};
  for (const [name, raw] of Object.entries(mcpServers)) {
    out[name] = parseEntry(`mcpServers.${name}`, raw);
  }
  return { mcpServers: out };
}

function parseEntry(path: string, raw: unknown): ServerEntry {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "stdio";

  validateDescription(path, obj);
  switch (type) {
    case "stdio":
      return parseStdio(path, obj);
    case "http":
    case "sse":
      return parseHttpLike(path, obj, type);
    default:
      // Unknown transport type — keep the entry verbatim so runtime can
      // skip-with-warn. No further validation, since we can't predict the shape.
      return { ...obj, type };
  }
}

function validateDescription(path: string, obj: Record<string, unknown>): void {
  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new ConfigError(`${path}.description must be a string`);
  }
}

function parseStdio(path: string, obj: Record<string, unknown>): ServerEntry {
  if (typeof obj.command !== "string" || obj.command.length === 0) {
    throw new ConfigError(`${path}.command must be a non-empty string`);
  }
  const entry: ServerEntry = { ...obj, type: "stdio", command: obj.command };
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || obj.args.some((a) => typeof a !== "string")) {
      throw new ConfigError(`${path}.args must be an array of strings`);
    }
    entry.args = obj.args as string[];
  }
  if (obj.env !== undefined) {
    if (!isPlainObject(obj.env)) {
      throw new ConfigError(`${path}.env must be an object of string values`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ConfigError(`${path}.env.${k} must be a string`);
      }
      env[k] = v;
    }
    entry.env = env;
  }
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      throw new ConfigError(`${path}.cwd must be a string`);
    }
    entry.cwd = obj.cwd;
  }
  return entry;
}

function parseHttpLike(
  path: string,
  obj: Record<string, unknown>,
  type: "http" | "sse",
): ServerEntry {
  if (typeof obj.url !== "string" || obj.url.length === 0) {
    throw new ConfigError(`${path}.url must be a non-empty string`);
  }
  const entry: ServerEntry = { ...obj, type, url: obj.url };
  if (obj.headers !== undefined) {
    if (!isPlainObject(obj.headers)) {
      throw new ConfigError(`${path}.headers must be an object of string values`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ConfigError(`${path}.headers.${k} must be a string`);
      }
      headers[k] = v;
    }
    entry.headers = headers;
  }
  return entry;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeConfigs(configs: readonly RatelConfig[]): RatelConfig {
  const out: Record<string, ServerEntry> = {};
  for (const c of configs) {
    for (const [name, entry] of Object.entries(c.mcpServers)) {
      out[name] = entry;
    }
  }
  return { mcpServers: out };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
