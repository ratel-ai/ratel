import type { SandboxRun } from "@/lib/views/sandboxes";

/**
 * What a row copies from a sandbox run of the Playground: its input, and its output as text for the
 * editor. A run that has not ended gives no row.
 */
export function rowOfSandboxRun(
  run: Pick<SandboxRun, "status" | "request" | "result" | "response">,
):
  | { ok: true; input: NonNullable<unknown> | null; output: string | null }
  | { ok: false; message: string } {
  if (run.status === "queued" || run.status === "running") {
    return {
      ok: false,
      message: `The sandbox run is ${run.status}. Wait until it ends, then save it.`,
    };
  }
  const output = run.result?.output ?? run.response?.output ?? null;
  return {
    ok: true,
    input: run.request.input ?? null,
    output: output === null ? null : typeof output === "string" ? output : JSON.stringify(output),
  };
}
