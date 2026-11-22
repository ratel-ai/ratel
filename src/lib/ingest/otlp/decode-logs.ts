import protobuf from "protobufjs";
import { anyValueToJs, attrBool, attrString, keyValuesToMap } from "./anyvalue";
import { RATEL_CATALOG } from "./constants";
import { OtlpDecodeError, toHexId, toMs } from "./decode";
import descriptor from "./proto/otlp-logs.descriptor.json";
import type {
  AttrValue,
  DecodedCatalogDefinition,
  DecodedLogRecord,
  IExportLogsServiceRequest,
  RawLogRecord,
} from "./types";

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const RequestType = root.lookupType("ratel.otlp.ExportLogsServiceRequest");

export { OtlpDecodeError };

/** Decode an OTLP logs export request into transport-neutral log records. */
export function decodeOtlpLogs(contentType: string, bytes: Uint8Array): DecodedLogRecord[] {
  return contentType.includes("application/json")
    ? decodeLogsJson(bytes)
    : decodeLogsProtobuf(bytes);
}

/** Decode an OTLP/JSON logs export request. */
export function decodeLogsJson(bytes: Uint8Array): DecodedLogRecord[] {
  let request: IExportLogsServiceRequest;
  try {
    request = JSON.parse(Buffer.from(bytes).toString("utf8")) as IExportLogsServiceRequest;
  } catch (err) {
    throw new OtlpDecodeError(`JSON parse failed: ${(err as Error).message}`);
  }
  if (typeof request !== "object" || request === null) {
    throw new OtlpDecodeError("OTLP/JSON body must be an object.");
  }

  return normalize(request);
}

/** Decode a protobuf OTLP logs export request. */
export function decodeLogsProtobuf(bytes: Uint8Array): DecodedLogRecord[] {
  let request: IExportLogsServiceRequest;
  try {
    const message = RequestType.decode(bytes);
    request = RequestType.toObject(message, {
      longs: String,
      bytes: Array,
      defaults: false,
      arrays: true,
      enums: Number,
    }) as IExportLogsServiceRequest;
  } catch (err) {
    throw new OtlpDecodeError(`protobuf decode failed: ${(err as Error).message}`);
  }
  return normalize(request);
}

function normalize(request: IExportLogsServiceRequest): DecodedLogRecord[] {
  const records: DecodedLogRecord[] = [];
  for (const resourceLogs of request.resourceLogs ?? []) {
    const resourceAttributes = keyValuesToMap(resourceLogs.resource?.attributes);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      const scopeName = scopeLogs.scope?.name ?? null;
      for (const record of scopeLogs.logRecords ?? []) {
        records.push(normalizeRecord(record, resourceAttributes, scopeName));
      }
    }
  }
  return records;
}

function normalizeRecord(
  record: RawLogRecord,
  resourceAttributes: DecodedLogRecord["resourceAttributes"],
  scopeName: string | null,
): DecodedLogRecord {
  const timeUnixNano = nanoString(record.timeUnixNano);
  const observedTimeUnixNano = nanoString(record.observedTimeUnixNano);
  const attributes = keyValuesToMap(record.attributes);
  const eventName = record.eventName || attrString(attributes, "event.name") || "";

  return {
    eventName,
    timeUnixNano,
    timeUnixMs: toMs(timeUnixNano),
    observedTimeUnixNano,
    observedTimeUnixMs: toMs(observedTimeUnixNano),
    traceId: nullableId(record.traceId),
    spanId: nullableId(record.spanId),
    severityNumber: typeof record.severityNumber === "number" ? record.severityNumber : 0,
    severityText: record.severityText ?? null,
    body: anyValueToJs(record.body),
    attributes,
    catalogDefinition: decodeCatalogDefinition(eventName, attributes),
    resourceAttributes,
    scopeName,
  };
}

function decodeCatalogDefinition(
  eventName: string,
  attributes: DecodedLogRecord["attributes"],
): DecodedCatalogDefinition | null {
  if (eventName !== RATEL_CATALOG.definition) return null;

  const kind = attrString(attributes, RATEL_CATALOG.kind);
  const entryId = attrString(attributes, RATEL_CATALOG.id);
  const name = attrString(attributes, RATEL_CATALOG.name);
  const description = attrString(attributes, RATEL_CATALOG.description);
  const searchableDescription = attrString(attributes, RATEL_CATALOG.searchableDescription);
  const searchableDescriptionOverridden = attrBool(
    attributes,
    RATEL_CATALOG.searchableDescriptionOverridden,
  );
  const contentHash = attrString(attributes, RATEL_CATALOG.contentHash);
  const tags = attributes[RATEL_CATALOG.tags];

  if (
    (kind !== "tool" && kind !== "skill" && kind !== "fact") ||
    !entryId ||
    name === undefined ||
    description === undefined ||
    searchableDescription === undefined ||
    searchableDescriptionOverridden === undefined ||
    !contentHash ||
    !/^[a-f0-9]{64}$/.test(contentHash) ||
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === "string")
  ) {
    return null;
  }

  let inputSchema: AttrValue | undefined | null = null;
  let outputSchema: AttrValue | undefined | null = null;
  if (kind === "tool") {
    const inputSchemaJson = attrString(attributes, RATEL_CATALOG.inputSchema);
    const outputSchemaJson = attrString(attributes, RATEL_CATALOG.outputSchema);
    inputSchema = jsonValue(inputSchemaJson);
    outputSchema = jsonValue(outputSchemaJson);
    const schemaOmitted = attrBool(attributes, RATEL_CATALOG.schemaOmitted) === true;
    if (
      (inputSchemaJson !== undefined && inputSchema === undefined) ||
      (outputSchemaJson !== undefined && outputSchema === undefined) ||
      (!schemaOmitted && (inputSchema === undefined || outputSchema === undefined))
    ) {
      return null;
    }
  }

  return {
    kind,
    entryId,
    name,
    description,
    tags,
    inputSchema: inputSchema ?? null,
    outputSchema: outputSchema ?? null,
    searchableDescription,
    searchableDescriptionOverridden,
    useCloudDefinitions: attrBool(attributes, RATEL_CATALOG.useCloudDefinitions) ?? false,
    contentHash,
  };
}

function jsonValue(value: string | undefined): AttrValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as AttrValue;
  } catch {
    return undefined;
  }
}

function nanoString(value: string | number | undefined): string {
  return value == null ? "" : String(value);
}

function nullableId(value: string | Uint8Array | number[] | undefined): string | null {
  const id = toHexId(value);
  return id.length > 0 && !/^0+$/.test(id) ? id : null;
}
