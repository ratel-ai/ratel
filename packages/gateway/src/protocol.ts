import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

/**
 * sandbox/v1 frames: the schemas (copied from the ratel repo, `protocol/sandbox/v1`)
 * and the envelope the gateway sends. Every frame in and out is validated.
 */

export interface Envelope {
  v: 1;
  type: string;
  id: string;
  ts: string;
  runId?: string;
  seq?: number;
  payload: Record<string, unknown>;
}

export interface Limits {
  maxFrameBytes: number;
  ackTimeoutMs: number;
  leaseIntervalMs: number;
  leaseTimeoutMs: number;
  confirmTimeoutMs: number;
  maxConcurrentRuns: number;
}

export const MAX_FRAME_BYTES = 65_536;
export const DEFAULT_LIMITS: Limits = {
  maxFrameBytes: MAX_FRAME_BYTES,
  ackTimeoutMs: 10_000,
  leaseIntervalMs: 15_000,
  leaseTimeoutMs: 60_000,
  confirmTimeoutMs: 600_000,
  maxConcurrentRuns: 4,
};

const MESSAGE_SCHEMA_ID = "https://ratel.sh/protocol/sandbox/v1/message.schema.json";
const MANIFEST_SCHEMA_ID = "https://ratel.sh/protocol/sandbox/v1/manifest.schema.json";

export interface FrameValidator {
  /** Null when the frame is valid, else a short reason (schema paths only, never values). */
  message(frame: unknown): string | null;
  manifest(manifest: unknown): string | null;
  /** The message types sandbox/v1 knows. A frame of another type is dropped. */
  knownTypes: ReadonlySet<string>;
}

/** The schema folder: `SANDBOX_PROTOCOL_DIR`, else `protocol/schema` under the working directory. */
export function schemaDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolve(env.SANDBOX_PROTOCOL_DIR ?? "protocol/schema");
}

export function loadValidator(dir: string = schemaDir()): FrameValidator {
  const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  addFormats(ajv);
  for (const file of schemaFiles(dir)) ajv.addSchema(JSON.parse(readFileSync(file, "utf8")));
  const message = ajv.getSchema(MESSAGE_SCHEMA_ID);
  const manifest = ajv.getSchema(MANIFEST_SCHEMA_ID);
  if (!message || !manifest) throw new Error(`sandbox/v1 schemas missing in ${dir}`);
  const messageSchema = JSON.parse(readFileSync(join(dir, "message.schema.json"), "utf8")) as {
    properties: { type: { enum: string[] } };
  };
  return {
    message: (frame) => explain(message, frame),
    manifest: (value) => explain(manifest, value),
    knownTypes: new Set(messageSchema.properties.type.enum),
  };
}

let frameCount = 0;

/** A controller frame with a fresh id and the current time. */
export function frame(
  type: string,
  payload: Record<string, unknown>,
  runId?: string,
  now: Date = new Date(),
): Envelope {
  return {
    v: 1,
    type,
    id: `gw_${Date.now().toString(36)}_${++frameCount}`,
    ts: now.toISOString(),
    ...(runId ? { runId } : {}),
    payload,
  };
}

function explain(validate: ValidateFunction, value: unknown): string | null {
  if (validate(value)) return null;
  const first = validate.errors?.[0];
  return first ? `${first.instancePath || "/"} ${first.message ?? "invalid"}` : "invalid";
}

function schemaFiles(dir: string): string[] {
  const top = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
  const messages = join(dir, "messages");
  return [
    ...top,
    ...readdirSync(messages)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(messages, f)),
  ];
}
