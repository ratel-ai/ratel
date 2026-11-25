import type { IngestResult } from "@/lib/contracts/ingest-queue";
import type { OtlpTransport } from "@/lib/ingest/otlp/http";
import { inflateBody, MAX_INFLATED_BYTES } from "@/lib/ingest/otlp/route-handler";
import type { Envelope, EnvelopeSignal } from "@/lib/ingest/queue/envelope";
import type { EnvelopeHandler } from "@/lib/ingest/queue/port/envelope-queue";
import { storeFailure } from "@/lib/ingest/queue/port/store-failure";
import type { LogError } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { reportServerException } from "@/lib/platform/telemetry";

/** The current rows of an envelope's project, which process reads for every delivery. */
export interface ProcessContext {
  projectId: string;
  organization: Organization | null;
  /** The clock of process: when accept took the request. */
  receivedAt: Date;
}

/** How a delivery ended, with what it stored. */
export interface Processed {
  result: IngestResult;
  counts: Record<string, number>;
}

export type ProcessSignal = (envelope: Envelope, context: ProcessContext) => Promise<Processed>;

export interface EnvelopeHandlerDeps extends Record<EnvelopeSignal, ProcessSignal> {
  /** Null for a project that does not exist. */
  findProject: (projectId: string) => Promise<{ organization: Organization | null } | null>;
}

/** The consumer's handler: process (ADR-0010) for one envelope. */
export function createEnvelopeHandler(deps: EnvelopeHandlerDeps): EnvelopeHandler {
  return async (envelope) => {
    try {
      const project = await deps.findProject(envelope.projectId);
      if (!project) return { outcome: "dead-letter", reason: "project does not exist" };
      const { result } = await deps[envelope.signal](envelope, {
        projectId: envelope.projectId,
        organization: project.organization,
        receivedAt: new Date(envelope.receivedAt),
      });
      return result;
    } catch (error) {
      return storeFailure(error);
    }
  };
}

export const STORED: IngestResult = { outcome: "ack" };

export function deadLetter(reason: string): Processed {
  return { result: { outcome: "dead-letter", reason }, counts: {} };
}

export function failed(error: unknown): Processed {
  return { result: storeFailure(error), counts: {} };
}

/** Reports a failure that process handles itself. Never throws. */
export function reportProcessFailure(
  error: unknown,
  {
    endpoint,
    projectId,
    deps,
    logError,
  }: {
    endpoint: string;
    projectId: string;
    deps: { reportServerException?: typeof reportServerException };
    logError: LogError;
  },
): void {
  try {
    (deps.reportServerException ?? reportServerException)(error, `project:${projectId}`, {
      endpoint,
      project_id: projectId,
    });
  } catch (captureError) {
    logError("exception capture failed", captureError, { project_id: projectId });
  }
}

type DecodedExport = { ok: true } | { ok: false; reason: "malformed" | "oversized" };

export function transportOf({ contentType }: Envelope): OtlpTransport {
  return contentType === "application/json" ? "json" : "protobuf";
}

/**
 * An OTLP envelope through the decode of the routes (`decodeTraceExport`, `decodeLogExport`). A body
 * that does not inflate or decode, or holds too many items, can never pass. The reasons quote nothing
 * of the body: a decoder's own message does.
 */
export function readOtlpExport<Decoded extends DecodedExport>(
  envelope: Envelope,
  {
    decode,
    limit,
  }: {
    decode: (transport: OtlpTransport, bytes: Uint8Array) => Decoded;
    /** What an oversized export has too many of. */
    limit: string;
  },
):
  | { ok: true; decoded: Extract<Decoded, { ok: true }>; bytes: Uint8Array }
  | { ok: false; processed: Processed } {
  const inflated = inflateBody(envelope.body, envelope.contentEncoding);
  if (!inflated.ok) {
    return refuse(
      inflated.reason === "too_large"
        ? `body is over ${MAX_INFLATED_BYTES} bytes decompressed`
        : `body is not valid ${envelope.contentEncoding}`,
    );
  }
  let decoded: Decoded;
  try {
    decoded = decode(transportOf(envelope), inflated.bytes);
  } catch {
    return refuse(`body does not decode as OTLP ${envelope.signal}`);
  }
  if (!decoded.ok) {
    return refuse(
      decoded.reason === "oversized"
        ? `body has more than ${limit}`
        : `body does not decode as OTLP ${envelope.signal}`,
    );
  }
  return { ok: true, decoded: decoded as Extract<Decoded, { ok: true }>, bytes: inflated.bytes };
}

function refuse(reason: string): { ok: false; processed: Processed } {
  return { ok: false, processed: deadLetter(reason) };
}
