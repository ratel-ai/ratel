import type { ExecResult } from "../ports/sandbox-provider";
import type { FakeProvider } from "./fake-provider";

/** How the agent image in a fake prepare VM behaves. */
export type AgentScript = {
  /** The id that `docker image inspect` reports. */
  imageId?: string;
  /** False: `docker run -d` fails. */
  starts?: boolean;
  /** `stopped`: the container ends before it is healthy. `no_port`: nothing listens on $PORT. */
  health?: "ok" | "never" | "stopped" | "no_port";
  /**
   * The answer of `POST /ratel/run` (HTTP mode), or the exit code of curl when it has none. A
   * function gets the run request. `hang`: the call never ends.
   */
  answer?: Answer | ((request: unknown) => Answer) | "hang";
  /** The end of the command (command mode). */
  command?: { exitCode: number; stdout?: string; stderr?: string };
  logs?: string;
  /** True: `docker rm -f` leaves the container. */
  keepsContainer?: boolean;
};

type Answer = { status: number; body: string } | { curlExit: number };

const ok = (stdout = "", exitCode = 0, stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

/**
 * Answers the Docker, curl and rm commands of a container in the fake provider: the files that
 * `rm -f` names leave the VM, and the containers that `docker run` or `docker create` makes stay
 * until `docker rm -f`. Docker gives each published port its own host port.
 */
export function scriptAgent(provider: FakeProvider, script: AgentScript = {}) {
  const containers = new Set<string>();
  /** Each container that was made, with its host port in HTTP mode. */
  const made: Array<{ name: string; hostPort: number | null }> = [];
  /** Each run request that a container got. */
  const requests: unknown[] = [];
  let nextPort = 32768;
  provider.onExec = (vm, { command }) => {
    const requestPath = /(?:@|< )(\/tmp\/\S+request\.json)/.exec(command)?.[1];
    const request = requestPath ? vm.files.get(requestPath)?.toString() : undefined;
    for (const [, targets] of command.matchAll(/rm -f ([^;&|>]+)/g)) {
      for (const target of (targets ?? "").trim().split(/\s+/)) {
        if (target.startsWith("/")) vm.files.delete(target);
        else if (!script.keepsContainer) containers.delete(target);
      }
    }
    const name = /--name (\S+)/.exec(command)?.[1] ?? "";
    if (command.startsWith("docker load")) return ok("Loaded image: agent:latest\n");
    if (command.startsWith("docker image inspect")) {
      return ok(`${script.imageId ?? `sha256:${"c".repeat(64)}`}\n`);
    }
    if (command.startsWith("docker create")) {
      if (script.starts === false) return ok("", 125, "docker: no such image.\n");
      containers.add(name);
      made.push({ name, hostPort: null });
      requests.push(request === undefined ? undefined : JSON.parse(request));
      const { exitCode, stdout = "", stderr = "" } = script.command ?? { exitCode: 0 };
      return ok(stdout, exitCode, stderr);
    }
    if (command.startsWith("docker run -d")) {
      if (script.starts === false) return ok("", 125, "docker: no such image.\n");
      containers.add(name);
      const hostPort = nextPort++;
      made.push({ name, hostPort });
      return ok(`c0ffee\n127.0.0.1:${hostPort}\n`);
    }
    if (command.includes("/ratel/health")) {
      const codes = { ok: 0, never: 1, stopped: 2, no_port: 3 };
      return ok("", codes[script.health ?? "ok"]);
    }
    if (command.includes("/ratel/run")) {
      const body = request === undefined ? undefined : JSON.parse(request);
      requests.push(body);
      if (script.answer === "hang") return new Promise<ExecResult>(() => {});
      const scripted = typeof script.answer === "function" ? script.answer(body) : script.answer;
      const answer = scripted ?? { status: 200, body: '{"output":{"reply":"refunded"}}' };
      if ("curlExit" in answer) return ok("", answer.curlExit, "curl: failed\n");
      return ok(`${answer.body}\n${answer.status}`);
    }
    if (command.startsWith("docker logs")) return ok(script.logs ?? "");
    if (command.startsWith("docker ps -aq")) {
      const files = [...vm.files.keys()].filter((path) => path.startsWith("/tmp/ratel-smoke-"));
      return ok([...containers, ...files].map((line) => `${line}\n`).join(""));
    }
    return command.includes("rm -f") ? ok() : undefined;
  };
  return { containers, made, requests };
}
