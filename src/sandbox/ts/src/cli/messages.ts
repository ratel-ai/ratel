import type { Manifest } from "../manifest.js";
import type { VerifyReport } from "../verify.js";
import type { ToolMode } from "./args.js";

/** What the CLI parent asks its worker over IPC. */
export type WorkerRequest =
  | {
      readonly kind: "list";
      readonly root: string;
      readonly files: readonly string[];
      readonly build?: Manifest["build"];
    }
  | {
      readonly kind: "run";
      readonly root: string;
      readonly files: readonly string[];
      readonly sandboxId: string;
      readonly input: unknown;
      readonly sets: readonly (readonly [string, string])[];
      readonly tools: Readonly<Record<string, ToolMode>>;
      /** Fake results by tool name, read from the --fake files. */
      readonly fakes: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "verify";
      readonly root: string;
      readonly files: readonly string[];
      readonly sandboxId: string;
      /** Absent: the sandbox's example input. */
      readonly input?: unknown;
      readonly model?: string;
      readonly dry: boolean;
    };

export type WorkerReply =
  | { readonly ok: true; readonly kind: "list"; readonly manifest: Manifest }
  | {
      readonly ok: true;
      readonly kind: "run";
      readonly output: unknown;
      readonly configHash: string;
      readonly overrides: readonly string[];
      readonly toolModes: Readonly<Record<string, ToolMode>>;
    }
  | { readonly ok: true; readonly kind: "verify"; readonly report: VerifyReport }
  | { readonly ok: false; readonly error: string };
