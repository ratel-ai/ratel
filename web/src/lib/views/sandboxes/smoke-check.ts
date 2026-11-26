import { randomUUID } from "node:crypto";
import type { RatelYaml } from "./domain/config";
import {
  judgeCommandAnswer,
  judgeHttpAnswer,
  redact,
  type SmokeAnswer,
  type SmokeResult,
  smokeRequest,
  tailOf,
} from "./domain/smoke";
import type { SandboxProvider } from "./ports/sandbox-provider";
import { envFile } from "./secret-values";

/**
 * The smoke check of a version in its prepare VM: one run of `input.example` with every tool
 * simulated, in a container of the loaded image. The variables (the secret values) go in a file
 * under /tmp, never on a command line: the service keeps command lines. The check removes its
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

export const ENV_FILE = "/tmp/ratel-smoke-env";
export const REQUEST_FILE = "/tmp/ratel-smoke-request.json";
/** The files of a smoke check start so. */
const FILE_PREFIX = "/tmp/ratel-smoke-";
const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_S = 300;
/** The total wait for `GET /ratel/health`. */
export const HEALTH_WAIT_S = 60;
/** The time that a command needs beyond its own timeout. */
const SLACK_S = 30;
const DOCKER_STEP_S = 120;
/** The shell keeps at most this end of the logs, before the redaction cuts it again. */
const SHELL_LOG_BYTES = 256 * 1024;

export async function runSmokeCheck(
  provider: SandboxProvider,
  vmRef: string,
  input: SmokeCheckInput,
): Promise<SmokeResult> {
  const { config, secrets, log } = input;
  const port = config.run?.port ?? DEFAULT_PORT;
  const name = `smoke-${input.versionId}`;
  const env = envFile({
    ...secrets,
    PORT: String(port),
    RATEL_SECRET_NAMES: Object.keys(secrets).join(","),
  });
  const request = JSON.stringify(smokeRequest(config, randomUUID()));
  const values = Object.values(secrets);
  log("> running the smoke check\n");
  await write(provider, vmRef, ENV_FILE, env);
  await write(provider, vmRef, REQUEST_FILE, request);
  const check = { ...input, name, port, timeoutS: config.run?.timeoutSeconds ?? DEFAULT_TIMEOUT_S };
  try {
    const { answer, durationMs, logs } =
      config.run?.mode === "command"
        ? await commandMode(provider, vmRef, check)
        : await httpMode(provider, vmRef, check);
    const cleanLogs = tailOf(redact(logs, values));
    const result: SmokeResult = answer.ok
      ? { ok: true, output: redactJson(answer.output, values), durationMs, logs: cleanLogs }
      : {
          ok: false,
          error: {
            code: answer.error.code,
            message: redact(answer.error.message, values),
          },
          durationMs,
          logs: cleanLogs,
        };
    log(
      result.ok ? "> the smoke check passed\n" : `> the smoke check failed: ${result.error.code}\n`,
    );
    return result;
  } finally {
    await provider.exec(vmRef, {
      command: `docker rm -f ${name} >/dev/null 2>&1; rm -f ${ENV_FILE} ${REQUEST_FILE}; true`,
      timeoutS: DOCKER_STEP_S,
    });
  }
}

/** Whether the VM holds no container and no file of a smoke check. */
export async function smokeLeftovers(provider: SandboxProvider, vmRef: string): Promise<string> {
  const found = await provider.exec(vmRef, {
    command: `docker ps -aq; ls -1d ${FILE_PREFIX}* 2>/dev/null; true`,
    timeoutS: DOCKER_STEP_S,
  });
  return found.exitCode === 0 ? found.stdout.trim() : "the check of the VM did not run";
}

type Check = SmokeCheckInput & { name: string; port: number; timeoutS: number };
type Ran = { answer: SmokeAnswer; durationMs: number; logs: string };

async function httpMode(provider: SandboxProvider, vmRef: string, check: Check): Promise<Ran> {
  const { name, port, tag, timeoutS } = check;
  const started = await provider.exec(vmRef, {
    // Docker reads the variables when it creates the container, so the file goes at once.
    command: `docker run -d --name ${name} -p 127.0.0.1:${port}:${port} --env-file ${ENV_FILE} ${tag}; code=$?; rm -f ${ENV_FILE}; exit $code`,
    timeoutS: DOCKER_STEP_S,
  });
  if (started.exitCode !== 0) {
    const why = started.stderr.trim().split("\n").at(-1) ?? "";
    const answer = fail("no_health", `The container did not start. ${why}`.trim());
    return { answer, durationMs: 0, logs: await logsOf(provider, vmRef, name) };
  }
  const health = await provider.exec(vmRef, {
    command: [
      `end=$(( $(date +%s) + ${HEALTH_WAIT_S} ))`,
      `while [ "$(date +%s)" -lt "$end" ]; do`,
      `curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:${port}/ratel/health && exit 0`,
      `[ "$(docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null)" = true ] || exit 2`,
      "sleep 1",
      "done",
      "exit 1",
    ].join("; "),
    timeoutS: HEALTH_WAIT_S + SLACK_S,
  });
  if (health.exitCode !== 0) {
    const message =
      health.exitCode === 2
        ? "The container stopped before GET /ratel/health answered 200."
        : `GET /ratel/health did not answer 200 in ${HEALTH_WAIT_S} s.`;
    return {
      answer: fail("no_health", message),
      durationMs: 0,
      logs: await logsOf(provider, vmRef, name),
    };
  }
  const startedAt = Date.now();
  const ran = await provider.exec(vmRef, {
    command: `curl -sS --max-time ${timeoutS} -X POST -H 'content-type: application/json' --data-binary @${REQUEST_FILE} -w '\\n%{http_code}' http://127.0.0.1:${port}/ratel/run; code=$?; rm -f ${REQUEST_FILE}; exit $code`,
    timeoutS: timeoutS + SLACK_S,
  });
  const durationMs = Date.now() - startedAt;
  const logs = await logsOf(provider, vmRef, name);
  if (ran.timedOut || ran.exitCode === 28) {
    return { answer: timedOut(timeoutS, "POST /ratel/run"), durationMs, logs };
  }
  if (ran.exitCode !== 0) {
    const message = `POST /ratel/run closed with no answer that is JSON (curl exit code ${ran.exitCode}).`;
    return { answer: fail("not_json", message), durationMs, logs };
  }
  const cut = ran.stdout.lastIndexOf("\n");
  const status = Number(ran.stdout.slice(cut + 1).trim());
  const body = cut < 0 ? "" : ran.stdout.slice(0, cut);
  return { answer: judgeHttpAnswer(status, body), durationMs, logs };
}

async function commandMode(provider: SandboxProvider, vmRef: string, check: Check): Promise<Ran> {
  const { name, tag, timeoutS, config } = check;
  const args = (config.run?.command ?? []).map(shellQuote).join(" ");
  const startedAt = Date.now();
  const ran = await provider.exec(vmRef, {
    command: `timeout ${timeoutS} docker run -i --rm --name ${name} --env-file ${ENV_FILE} ${tag} ${args} < ${REQUEST_FILE}; code=$?; rm -f ${ENV_FILE} ${REQUEST_FILE}; exit $code`,
    timeoutS: timeoutS + SLACK_S,
  });
  const durationMs = Date.now() - startedAt;
  const logs = tailOf(ran.stderr, SHELL_LOG_BYTES);
  // `timeout` ends with 124 when the time is over.
  if (ran.timedOut || ran.exitCode === 124 || ran.exitCode === null) {
    return { answer: timedOut(timeoutS, "The command"), durationMs, logs };
  }
  return { answer: judgeCommandAnswer(ran.exitCode, ran.stdout), durationMs, logs };
}

async function logsOf(provider: SandboxProvider, vmRef: string, name: string): Promise<string> {
  const logs = await provider.exec(vmRef, {
    command: `docker logs ${name} 2>&1 | tail -c ${SHELL_LOG_BYTES}`,
    timeoutS: DOCKER_STEP_S,
  });
  return logs.stdout;
}

async function write(provider: SandboxProvider, vmRef: string, path: string, text: string) {
  const body = Buffer.from(text);
  await provider.writeFile(vmRef, { path, body, size: body.length });
}

function timedOut(timeoutS: number, what: string): SmokeAnswer {
  return fail("timeout", `${what} did not answer in ${timeoutS} s (run.timeoutSeconds).`);
}

function fail(code: string, message: string): SmokeAnswer {
  return { ok: false, error: { code, message } };
}

/** Each text of a JSON value with the secret values replaced. */
function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, secrets)]),
    );
  }
  return value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
