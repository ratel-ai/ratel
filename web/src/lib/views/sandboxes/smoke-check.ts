import { randomUUID } from "node:crypto";
import { DEFAULT_TIMEOUT_S, runContainer } from "./container-run";
import type { RatelYaml } from "./domain/config";
import { type RunResponse, type SmokeResult, smokeRequest } from "./domain/contract";
import type { VmSession } from "./vm-session";

/**
 * The smoke check of a version: one run of `input.example` with every tool simulated, in a
 * container of the loaded image (`container-run.ts`). It runs in a smoke VM that starts from the
 * snapshot of the version and is deleted after the check: the VM gets the secrets, so it never
 * becomes a snapshot.
 */
export type SmokeCheckInput = {
  versionId: string;
  config: RatelYaml;
  /** The image in the VM. */
  tag: string;
  secrets: Record<string, string>;
  log: (text: string) => void;
};

/** The files of a smoke check start so. */
const FILE_PREFIX = "/tmp/ratel-smoke-";

export async function runSmokeCheck(vm: VmSession, input: SmokeCheckInput): Promise<SmokeResult> {
  const { config, log } = input;
  log("> running the smoke check\n");
  const { answer, durationMs, logs } = await runContainer(vm, {
    name: `smoke-${input.versionId}`,
    filePrefix: FILE_PREFIX,
    config,
    tag: input.tag,
    secrets: input.secrets,
    request: smokeRequest(config, randomUUID()),
    timeoutS: config.run?.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
  });
  const result: SmokeResult = answer.ok
    ? {
        ok: true,
        output: answer.response.output,
        ...callsAndUsage(answer.response),
        durationMs,
        logs,
      }
    : { ok: false, error: answer.error, durationMs, logs };
  log(
    result.ok ? "> the smoke check passed\n" : `> the smoke check failed: ${result.error.code}\n`,
  );
  return result;
}

/** The tool calls and the usage of an answer, only the ones it has. */
function callsAndUsage({
  toolCalls,
  usage,
}: RunResponse): Pick<RunResponse, "toolCalls" | "usage"> {
  return { ...(toolCalls ? { toolCalls } : {}), ...(usage ? { usage } : {}) };
}
