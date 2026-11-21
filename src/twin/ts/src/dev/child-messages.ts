import type { Manifest } from "../manifest.js";
import type { RunEventPayload, RunResult, RunStartPayload } from "./runs.js";
import type { PlaygroundTelemetryConfig } from "./tracing.js";

/** What the `ratel dev` parent tells its long-lived child worker over IPC. */
export type ChildRequest =
  | {
      readonly id: number;
      readonly kind: "manifest";
      readonly root: string;
      readonly files: readonly string[];
      readonly build?: Manifest["build"];
      /** Where playground traces go. Absent: no export (a local-only run). */
      readonly telemetry?: PlaygroundTelemetryConfig;
    }
  | { readonly kind: "run"; readonly runId: string; readonly start: RunStartPayload }
  | { readonly kind: "cancel"; readonly runId: string; readonly reason: string };

export type ChildReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: "manifest";
      readonly manifest: Manifest;
    }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: "run.event"; readonly runId: string; readonly payload: RunEventPayload }
  | { readonly kind: "run.end"; readonly runId: string; readonly result: RunResult };
