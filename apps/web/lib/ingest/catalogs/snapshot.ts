import { createHash } from "node:crypto";

export const MAX_CATALOG_TOOLS = 5_000;

export type CatalogSnapshotTool = {
  toolId: string;
  name: string;
  description: string;
  /**
   * What Ratel matches prompts against, when the publisher separates the two.
   * Absent means "match on `description`", which is what every publisher sent
   * before this field existed, so the key stays out of the canonical form and
   * their snapshot hashes are unchanged.
   */
  searchableDescription?: string;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type CatalogSnapshot = {
  sourceId: string;
  tools: CatalogSnapshotTool[];
  hash: string;
  etag: string;
};

/** Parse and content-address one source's complete tool inventory. */
export function parseCatalogSnapshot(value: unknown): CatalogSnapshot {
  if (!isRecord(value)) throw new Error("expected an object");
  const sourceId = aliasedString(value, "source_id", "sourceId", "source_id");
  if (sourceId.length > 512) throw new Error("source_id exceeds 512 characters");
  if (!Array.isArray(value.tools)) throw new Error("tools must be an array");
  if (value.tools.length > MAX_CATALOG_TOOLS) {
    throw new Error(`tools exceeds ${MAX_CATALOG_TOOLS} entries`);
  }

  const tools = value.tools
    .map(parseTool)
    .sort((a, b) => Buffer.compare(Buffer.from(a.toolId), Buffer.from(b.toolId)));
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.toolId)) throw new Error(`duplicate tool id: ${tool.toolId}`);
    seen.add(tool.toolId);
  }

  const canonical = stableJson({ source_id: sourceId, tools });
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { sourceId, tools, hash, etag: `"${hash}"` };
}

function parseTool(value: unknown, index: number): CatalogSnapshotTool {
  if (!isRecord(value)) throw new Error(`tools[${index}] must be an object`);
  const name = requiredString(value.name, `tools[${index}].name`);
  const toolId = optionalString(value.id, `tools[${index}].id`) ?? name;
  const description = optionalString(value.description, `tools[${index}].description`) ?? "";
  if (toolId.length > 512 || name.length > 512) {
    throw new Error(`tools[${index}] id and name must not exceed 512 characters`);
  }
  if (description.length > 16_384) {
    throw new Error(`tools[${index}].description exceeds 16384 characters`);
  }
  const searchableDescription = optionalAliasedString(
    value,
    "searchable_description",
    "searchableDescription",
    `tools[${index}].searchable_description`,
  );
  if (searchableDescription && searchableDescription.length > 16_384) {
    throw new Error(`tools[${index}].searchable_description exceeds 16384 characters`);
  }
  return {
    toolId,
    name,
    description,
    ...(searchableDescription === undefined ? {} : { searchableDescription }),
    inputSchema: aliasedObject(value, "input_schema", "inputSchema", "parameters"),
    outputSchema: aliasedObject(value, "output_schema", "outputSchema"),
    metadata: optionalObject(value.metadata, `tools[${index}].metadata`),
  };
}

function aliasedString(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  label: string,
): string {
  const snakeValue = optionalString(value[snake], label);
  const camelValue = optionalString(value[camel], label);
  if (snakeValue && camelValue && snakeValue !== camelValue) {
    throw new Error(`${snake} and ${camel} must match`);
  }
  const result = snakeValue ?? camelValue;
  if (!result) throw new Error(`${label} is required`);
  return result;
}

/** `aliasedString` without the required check, for optional wire fields. */
function optionalAliasedString(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  label: string,
): string | undefined {
  const snakeValue = optionalString(value[snake], label);
  const camelValue = optionalString(value[camel], label);
  if (snakeValue && camelValue && snakeValue !== camelValue) {
    throw new Error(`${snake} and ${camel} must match`);
  }
  return snakeValue ?? camelValue;
}

function aliasedObject(
  value: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    if (value[key] !== undefined) return optionalObject(value[key], key);
  }
  return null;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertJsonValue(value, label);
  return value;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const result = value.trim();
  return result || undefined;
}

function assertJsonValue(value: unknown, label: string): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new Error(`${label} must contain JSON values`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
