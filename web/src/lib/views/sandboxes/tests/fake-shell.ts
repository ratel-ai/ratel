import type { ExecResult } from "../ports/sandbox-provider";

/**
 * A very small shell for the fakes of the sandbox provider. It knows the commands that the
 * contract test sends: `echo`, `cat`, `exit`, `sleep`, a wait for Docker, and stdin given as
 * `( command ) < 'file'`. Any other command ends with exit code 0 and no output.
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
