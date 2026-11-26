import type { ExecResult } from "../ports/sandbox-provider";

/**
 * A very small shell for the fakes of the sandbox provider. It knows the commands that the
 * contract test sends: `echo`, `cat`, `exit`, `sleep`, `rm -f`, a wait for Docker, stdin given as
 * `( command ) < 'file'`, and the start of a job and the wait for its end (`boat-provider.ts`). A
 * job runs to its end at its start. Any other command ends with exit code 0 and no output.
 */
export function runFakeShell(
  command: string,
  files: Map<string, Buffer>,
  timeoutS: number,
  stdin = "",
): ExecResult {
  const redirected = /^\( ([\s\S]*) \) < '([^']+)'$/.exec(command);
  if (redirected) {
    const input = files.get(redirected[2] ?? "")?.toString() ?? "";
    return runFakeShell(redirected[1] ?? "", files, timeoutS, input);
  }
  const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
  const job =
    /^setsid nohup sh -c 'timeout -k \d+ (\d+) sh (\S+) > (\S+) 2> (\S+); echo \$\? > \S+ && mv \S+ (\S+)'/.exec(
      command,
    );
  if (job) {
    const [, seconds, script, out, err, exit] = job;
    const body = files.get(script ?? "")?.toString() ?? "";
    const ran = runFakeShell(body, files, Number(seconds));
    files.set(out ?? "", Buffer.from(ran.stdout));
    files.set(err ?? "", Buffer.from(ran.stderr));
    files.set(exit ?? "", Buffer.from(`${ran.timedOut ? 124 : ran.exitCode}\n`));
    return ok();
  }
  const jobWait = /\[ -f (\S+) \] && cat \S+ && exit 0/.exec(command);
  if (jobWait) {
    const code = files.get(jobWait[1] ?? "");
    return code ? ok(code.toString()) : { exitCode: 1, stdout: "", stderr: "", timedOut: false };
  }
  const removed = /(?:^|; )rm -f ([^;]+)/.exec(command);
  if (removed) {
    for (const path of (removed[1] ?? "").trim().split(/\s+/)) files.delete(path);
    return ok();
  }
  const exit = /^exit (\d+)$/.exec(command);
  if (exit) return { exitCode: Number(exit[1]), stdout: "", stderr: "", timedOut: false };
  const sleep = /^sleep (\d+)$/.exec(command);
  if (sleep && Number(sleep[1]) > timeoutS) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  }
  if (command === "cat") return ok(stdin);
  const cat = /^cat '?([^']+)'?$/.exec(command);
  if (cat) {
    const body = files.get(cat[1] ?? "");
    if (!body) return { exitCode: 1, stdout: "", stderr: "No such file\n", timedOut: false };
    return ok(body.toString());
  }
  const echo = /^echo (.*)$/.exec(command);
  if (echo) return ok(`${echo[1]}\n`);
  return ok();
}
