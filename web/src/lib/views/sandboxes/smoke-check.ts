import { randomUUID } from "node:crypto";
import { DEFAULT_TIMEOUT_S, runContainer } from "./container-run";
import type { RatelYaml } from "./domain/config";
import { type SmokeResult, smokeRequest } from "./domain/contract";
import type { SandboxProvider } from "./ports/sandbox-provider";

/**
 * The smoke check of a version in its prepare VM: one run of `input.example` with every tool
 * simulated, in a container of the loaded image (`container-run.ts`). The check removes its
 * container and its files at the end, so no snapshot holds a secret value.
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
const DOCKER_STEP_S = 120;

export async function runSmokeCheck(
  provider: SandboxProvider,
  vmRef: string,
  input: SmokeCheckInput,
): Promise<SmokeResult> {
  const { config, log } = input;
  log("> running the smoke check\n");
  const { answer, durationMs, logs } = await runContainer(provider, vmRef, {
    name: `smoke-${input.versionId}`,
    filePrefix: FILE_PREFIX,
    config,
    tag: input.tag,
    secrets: input.secrets,
    request: smokeRequest(config, randomUUID()),
    timeoutS: config.run?.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
  });
  const result: SmokeResult = answer.ok
    ? { ok: true, output: answer.response.output, durationMs, logs }
    : { ok: false, error: answer.error, durationMs, logs };
  log(
    result.ok ? "> the smoke check passed\n" : `> the smoke check failed: ${result.error.code}\n`,
  );
  return result;
}

/** Whether the VM holds no container and no file of a smoke check. */
export async function smokeLeftovers(provider: SandboxProvider, vmRef: string): Promise<string> {
  const found = await provider.exec(vmRef, {
    command: `docker ps -aq; ls -1d ${FILE_PREFIX}* 2>/dev/null; true`,
    timeoutS: DOCKER_STEP_S,
  });
  return found.exitCode === 0 ? found.stdout.trim() : "the check of the VM did not run";
}
