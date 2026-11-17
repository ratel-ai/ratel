import { gzipSync } from "node:zlib";

/**
 * Raw OTLP capture: the full request body of an accepted export, kept within a
 * per-project daily byte cap and a retention window, so that we can see what a
 * customer sends and reprocess it later. Bodies are always stored gzipped.
 */

export type OtlpRawSignal = "traces" | "logs";

export interface OtlpRawExportInput {
  projectId: string;
  signal: OtlpRawSignal;
  contentType: string;
  /** The inflated request body, exactly as the decoder read it. */
  body: Uint8Array;
  /** The body as it came on the wire, when the client sent it gzipped. */
  gzipped?: Uint8Array;
  itemCount: number;
  traceIds: string[];
}

export type OtlpRawStoreResult =
  | { stored: true; id: string; rawBytes: number; storedBytes: number }
  | {
      stored: false;
      skipped: OtlpRawSkipReason;
      rawBytes: number;
      storedBytes: number;
      usedBytes: number;
      capBytes: number;
    };

export type OtlpRawSkipReason = "over_daily_cap";

export interface OtlpRawStore {
  store(input: OtlpRawExportInput): Promise<OtlpRawStoreResult>;
}

export const DEFAULT_OTLP_RAW_DAILY_BYTES = 1024 ** 3;
export const DEFAULT_OTLP_RAW_RETENTION_DAYS = 30;
export const OTLP_RAW_PRUNE_BATCH_SIZE = 500;

const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** The bytes to store: the wire gzip when there is one, else a fresh gzip. */
export function compressForStorage(
  input: Pick<OtlpRawExportInput, "body" | "gzipped">,
): Uint8Array {
  if (input.gzipped && isGzip(input.gzipped)) return input.gzipped;
  return new Uint8Array(gzipSync(input.body));
}

/** Stored bytes one project may add per UTC day. 0 stores nothing. */
export function otlpRawDailyByteCap(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.OTLP_RAW_DAILY_BYTES);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_OTLP_RAW_DAILY_BYTES;
}

export function otlpRawRetentionDays(
  override?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (isValidRetentionDays(override)) return override;
  const configured = Number(env.OTLP_RAW_RETENTION_DAYS);
  return isValidRetentionDays(configured) ? configured : DEFAULT_OTLP_RAW_RETENTION_DAYS;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

function isValidRetentionDays(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
