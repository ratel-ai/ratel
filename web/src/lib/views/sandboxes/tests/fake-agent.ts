import type { ExecResult } from "../ports/sandbox-provider";
import type { FakeProvider } from "./fake-provider";

/** How the agent image in a fake prepare VM behaves. */
export type AgentScript = {
  /** The id that `docker image inspect` reports. */
  imageId?: string;
  /** False: `docker run -d` fails. */
  starts?: boolean;
  /** `stopped`: the container ends before it is healthy. */
  health?: "ok" | "never" | "stopped";
  /** The answer of `POST /ratel/run` (HTTP mode), or the exit code of curl when it has none. */
  answer?: { status: number; body: string } | { curlExit: number };
  /** The end of the command (command mode). */
  command?: { exitCode: number; stdout?: string; stderr?: string };
  logs?: string;
  /** True: `docker rm -f` leaves the container. */
  keepsContainer?: boolean;
};

const ok = (stdout = "", exitCode = 0, stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

/**
 * Answers the Docker, curl and rm commands of a prepare in the fake provider: the files that `rm -f`
 * names leave the VM, and the containers that `docker run` starts stay until `docker rm -f`.
 */
export function scriptAgent(provider: FakeProvider, script: AgentScript = {}) {
  const containers = new Set<string>();
  provider.onExec = (vm, { command }) => {
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
    if (command.startsWith("docker run -d")) {
      if (script.starts === false) return ok("", 125, "docker: no such image.\n");
      containers.add(name);
      return ok("c0ffee\n");
    }
    if (command.includes("/ratel/health")) {
      const health = script.health ?? "ok";
      return ok("", health === "ok" ? 0 : health === "never" ? 1 : 2);
    }
    if (command.includes("/ratel/run")) {
      const answer = script.answer ?? { status: 200, body: '{"output":{"reply":"refunded"}}' };
      if ("curlExit" in answer) return ok("", answer.curlExit, "curl: failed\n");
      return ok(`${answer.body}\n${answer.status}`);
    }
    if (command.includes("docker run -i")) {
      if (!script.keepsContainer) containers.delete(name);
      const { exitCode, stdout = "", stderr = "" } = script.command ?? { exitCode: 0 };
      return ok(stdout, exitCode, stderr);
    }
    if (command.startsWith("docker logs")) return ok(script.logs ?? "");
    if (command.startsWith("docker ps -aq")) {
      const files = [...vm.files.keys()].filter((path) => path.startsWith("/tmp/ratel-smoke-"));
      return ok([...containers, ...files].map((line) => `${line}\n`).join(""));
    }
    return command.includes("rm -f") ? ok() : undefined;
  };
  return { containers };
}
