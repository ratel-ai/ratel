import { getLogger } from "@/lib/platform/logger";
import type { RatelYaml } from "./domain/config";
import {
  type ContainerAnswer,
  judgeCommandAnswer,
  judgeHttpAnswer,
  redact,
  tailOf,
} from "./domain/contract";
import { envFile } from "./secret-values";
import type { VmSession } from "./vm-session";

/**
 * One run of an agent image in a new container of a VM: the smoke check of a version and each
 * run use it. The variables go in a file under /tmp, never on a command line: the service keeps
 * command lines. Docker reads the file when it creates the container, and the file goes at once.
 * Each container has its own name, its own files and its own host port, so runs on one VM do not
 * clash. The container, its anonymous volumes and the files are removed at the end, also after a
 * failure. The env file is a secret file of the {@link VmSession}: after it, the VM never becomes a
 * snapshot.
 */
export type ContainerRunInput = {
  /** The name of the container. It is unique in the VM. */
  name: string;
  /** The start of the paths of the files of this run, e.g. `/tmp/ratel-smoke-`. */
  filePrefix: string;
  config: RatelYaml;
  /** The image in the VM. */
  tag: string;
  /** The secret values. Their names go in `RATEL_SECRET_NAMES`. */
  secrets: Record<string, string>;
  /** Other variables. */
  env?: Record<string, string>;
  /** More values that the output and the logs must not show. */
  hidden?: readonly string[];
  /** The `run-request`. */
  request: unknown;
  timeoutS: number;
};

export type ContainerRun = {
  /** Redacted. */
  answer: ContainerAnswer;
  durationMs: number;
  /** Redacted, and the end only. */
  logs: string;
  /** False when the removal of the container or its files did not run. */
  cleaned: boolean;
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_TIMEOUT_S = 300;
/** The total wait for `GET /ratel/health`. */
export const HEALTH_WAIT_S = 60;
/** The time that a command needs beyond its own timeout. */
const SLACK_S = 30;
const DOCKER_STEP_S = 120;
/** The shell keeps at most this end of the logs, before the redaction cuts it again. */
const SHELL_LOG_BYTES = 256 * 1024;
/** Exit codes of the health wait. */
const STOPPED = 2;
const NOTHING_LISTENS = 3;
/** curl: the time is over; the connection failed. */
const CURL_TIMEOUT = 28;
/** `timeout` ends with 124 when the time is over. */
const COMMAND_TIMEOUT = 124;

const logger = getLogger("sandboxes/container-run");

export async function runContainer(vm: VmSession, input: ContainerRunInput): Promise<ContainerRun> {
  const { config, secrets, filePrefix } = input;
  const port = config.run?.port ?? DEFAULT_PORT;
  const files = { env: `${filePrefix}env`, request: `${filePrefix}request.json` };
  const env = envFile({
    ...secrets,
    ...input.env,
    PORT: String(port),
    RATEL_SECRET_NAMES: Object.keys(secrets).join(","),
  });
  const hidden = [...Object.values(secrets), ...(input.hidden ?? [])];
  const run: Run = { ...input, port, files };
  let ran: Ran;
  let cleaned = false;
  try {
    const envBody = Buffer.from(env);
    await vm.writeSecretFile({ path: files.env, body: envBody, size: envBody.length });
    const requestBody = Buffer.from(JSON.stringify(input.request));
    await vm.writeFile({ path: files.request, body: requestBody, size: requestBody.length });
    ran = config.run?.mode === "command" ? await commandMode(vm, run) : await httpMode(vm, run);
  } finally {
    cleaned = await clean(vm, run);
  }
  return {
    answer: redactAnswer(ran.answer, hidden),
    durationMs: ran.durationMs,
    logs: tailOf(redact(ran.logs, hidden)),
    cleaned,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type Run = ContainerRunInput & { port: number; files: { env: string; request: string } };
type Ran = { answer: ContainerAnswer; durationMs: number; logs: string };

async function httpMode(vm: VmSession, run: Run): Promise<Ran> {
  const { name, port, tag, timeoutS, files } = run;
  // Docker picks a free host port, so two containers of one VM do not clash.
  const started = await vm.exec({
    command: `docker run -d --name ${name} -p 127.0.0.1::${port} --env-file ${files.env} ${tag}; code=$?; rm -f ${files.env}; [ $code -eq 0 ] || exit $code; docker port ${name} ${port}/tcp | head -n 1`,
    timeoutS: DOCKER_STEP_S,
  });
  if (started.exitCode !== 0) {
    const why = started.stderr.trim().split("\n").at(-1) ?? "";
    const answer = fail("no_health", `The container did not start. ${why}`.trim());
    return await ended(vm, run, answer, 0);
  }
  const hostPort = /:(\d+)\s*$/.exec(started.stdout.trim())?.[1];
  if (!hostPort) {
    const answer = fail("no_port", `Docker published no port for $PORT (${port}).`);
    return await ended(vm, run, answer, 0);
  }
  const base = `http://127.0.0.1:${hostPort}`;
  const health = await vm.exec({
    command: [
      `end=$(( $(date +%s) + ${HEALTH_WAIT_S} ))`,
      "last=0",
      // No ";" right after "do": no shell takes it.
      `while [ "$(date +%s)" -lt "$end" ]; do curl -fsS -o /dev/null --max-time 5 ${base}/ratel/health && exit 0`,
      "last=$?",
      `[ "$(docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null)" = true ] || exit ${STOPPED}`,
      "sleep 1",
      "done",
      // curl ends with 7 when nothing listens on the port.
      `[ "$last" = 7 ] && exit ${NOTHING_LISTENS}`,
      "exit 1",
    ].join("; "),
    timeoutS: HEALTH_WAIT_S + SLACK_S,
  });
  if (health.exitCode !== 0) {
    return await ended(vm, run, healthFailure(health.exitCode, port), 0);
  }
  const startedAt = Date.now();
  const answered = await vm.exec({
    command: `curl -sS --max-time ${timeoutS} -X POST -H 'content-type: application/json' --data-binary @${files.request} -w '\\n%{http_code}' ${base}/ratel/run; code=$?; rm -f ${files.request}; exit $code`,
    timeoutS: timeoutS + SLACK_S,
  });
  const durationMs = Date.now() - startedAt;
  if (answered.timedOut || answered.exitCode === CURL_TIMEOUT) {
    return await ended(vm, run, timedOut(timeoutS, "POST /ratel/run"), durationMs);
  }
  if (answered.exitCode !== 0) {
    const message = `POST /ratel/run closed with no answer (curl exit code ${answered.exitCode}).`;
    return await ended(vm, run, fail("no_answer", message), durationMs);
  }
  const cut = answered.stdout.lastIndexOf("\n");
  const status = Number(answered.stdout.slice(cut + 1).trim());
  const body = cut < 0 ? "" : answered.stdout.slice(0, cut);
  return await ended(vm, run, judgeHttpAnswer(status, body), durationMs);
}

/**
 * The request goes on stdin. `docker create` reads the variables, so the file goes before the
 * command runs.
 */
async function commandMode(vm: VmSession, run: Run): Promise<Ran> {
  const { name, tag, timeoutS, config, files } = run;
  const args = (config.run?.command ?? []).map(shellQuote).join(" ");
  const startedAt = Date.now();
  const ran = await vm.exec({
    command: `docker create -i --name ${name} --env-file ${files.env} ${tag} ${args} >/dev/null; code=$?; rm -f ${files.env}; [ $code -eq 0 ] || exit $code; timeout ${timeoutS} docker start -ai ${name} < ${files.request}; code=$?; rm -f ${files.request}; exit $code`,
    timeoutS: timeoutS + SLACK_S,
  });
  const durationMs = Date.now() - startedAt;
  const logs = tailOf(ran.stderr, SHELL_LOG_BYTES);
  if (ran.timedOut || ran.exitCode === COMMAND_TIMEOUT || ran.exitCode === null) {
    return { answer: timedOut(timeoutS, "The command"), durationMs, logs };
  }
  return { answer: judgeCommandAnswer(ran.exitCode, ran.stdout), durationMs, logs };
}

function healthFailure(exitCode: number | null, port: number): ContainerAnswer {
  if (exitCode === STOPPED) {
    return fail("no_health", "The container stopped before GET /ratel/health answered 200.");
  }
  if (exitCode === NOTHING_LISTENS) {
    return fail("no_port", `Nothing listens on $PORT (${port}) after ${HEALTH_WAIT_S} s.`);
  }
  return fail("no_health", `GET /ratel/health did not answer 200 in ${HEALTH_WAIT_S} s.`);
}

/** The end of an HTTP run: the logs of the container, read before it is removed. */
async function ended(
  vm: VmSession,
  run: Run,
  answer: ContainerAnswer,
  durationMs: number,
): Promise<Ran> {
  const logs = await vm.exec({
    command: `docker logs ${run.name} 2>&1 | tail -c ${SHELL_LOG_BYTES}`,
    timeoutS: DOCKER_STEP_S,
  });
  return { answer, durationMs, logs: logs.stdout };
}

/**
 * Removes the container with its anonymous volumes, and the files. A failure is logged: the caller
 * decides about the VM.
 */
async function clean(vm: VmSession, run: Run): Promise<boolean> {
  try {
    const removed = await vm.exec({
      command: `docker rm -f -v ${run.name} >/dev/null 2>&1; rm -f ${run.files.env} ${run.files.request}; true`,
      timeoutS: DOCKER_STEP_S,
    });
    return removed.exitCode === 0;
  } catch (error) {
    logger.warn({ err: error }, "container not removed");
    return false;
  }
}

function timedOut(timeoutS: number, what: string): ContainerAnswer {
  return fail("timeout", `${what} did not answer in ${timeoutS} s (run.timeoutSeconds).`);
}

function fail(code: string, message: string): ContainerAnswer {
  return { ok: false, error: { code, message } };
}

function redactAnswer(answer: ContainerAnswer, hidden: readonly string[]): ContainerAnswer {
  if (!answer.ok) {
    return { ok: false, error: { ...answer.error, message: redact(answer.error.message, hidden) } };
  }
  return { ok: true, response: redactJson(answer.response, hidden) as typeof answer.response };
}

/** Each text of a JSON value with the secret values replaced. */
function redactJson(value: unknown, hidden: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, hidden);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, hidden));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, hidden)]),
    );
  }
  return value;
}
