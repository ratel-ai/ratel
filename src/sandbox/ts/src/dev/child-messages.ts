import type { Manifest } from "../manifest.js";
import type {
  RunEventPayload,
  RunResult,
  RunStartPayload,
  ToolAnswerType,
  ToolRequestType,
} from "./runs.js";
import type { PlaygroundTelemetryConfig } from "./tracing.js";

/** What the `ratel sandbox dev` parent tells its long-lived child worker over IPC. */
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
  | { readonly kind: "cancel"; readonly runId: string; readonly reason: string }
  /** The controller's answer to a tool.request of a run. */
  | {
      readonly kind: "tool.answer";
      readonly runId: string;
      readonly answerType: ToolAnswerType;
      readonly payload: Readonly<Record<string, unknown>>;
    };

export type ChildReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: "manifest";
      readonly manifest: Manifest;
    }
  | { readonly id: number; readonly ok: false; readonly error: string }
  /** A run read a prompt or model through the SDK catalog that the load did not reach: its new params. */
  | { readonly kind: "manifest.grew"; readonly manifest: Manifest }
  | { readonly kind: "run.event"; readonly runId: string; readonly payload: RunEventPayload }
  | { readonly kind: "run.end"; readonly runId: string; readonly result: RunResult }
  /** A fake or confirm tool call waits for the controller. */
  | {
      readonly kind: "tool.request";
      readonly runId: string;
      readonly type: ToolRequestType;
      readonly payload: { readonly callId: string } & Readonly<Record<string, unknown>>;
    };
