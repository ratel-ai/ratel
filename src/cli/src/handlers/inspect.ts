import type { ParsedArgs } from "../args.js";
import { defaultTelemetryDir, listSessions, summarizeSession } from "../inspect.js";

export const INSPECT_USAGE = `usage: ratel inspect [verb] [args...]

Default (no verb) summarizes the most recent telemetry file in the bucket for
the current cwd, under \`$RATEL_TELEMETRY_DIR/<project-slug>/\` (default root
\`~/.ratel/telemetry/\`). The slug mirrors Claude Code's \`~/.claude/projects/\`
convention: every \`/\` and \`.\` in the absolute path becomes \`-\`.

Flags:
  --from <FILE>          summarize a specific JSONL file
  --last <N>             restrict the summary to the last N events
  --project <ABS-PATH>   target another project's bucket explicitly
  --all                  scan every bucket and pick the global newest

Verbs:
  ls   list telemetry files in the cwd's bucket (most recent first; use --all to enumerate every bucket)`;

export async function runInspect(parsed: ParsedArgs, log: (m: string) => void): Promise<void> {
  if (parsed.flags.help === true) {
    log(INSPECT_USAGE);
    return;
  }
  const all = parsed.flags.all === true;
  const projectFlag = parsed.flags.project;
  const project = typeof projectFlag === "string" ? projectFlag : undefined;
  if (parsed.verb === "ls") {
    const listOpts: { project?: string; all?: boolean } = {};
    if (all) listOpts.all = true;
    if (project) listOpts.project = project;
    log(await listSessions(defaultTelemetryDir(), listOpts));
    return;
  }
  const opts: { from?: string; last?: number; project?: string; all?: boolean } = {};
  const from = parsed.flags.from;
  if (typeof from === "string") opts.from = from;
  const last = parsed.flags.last;
  if (typeof last === "string") {
    const n = Number.parseInt(last, 10);
    if (Number.isFinite(n)) opts.last = n;
  }
  if (all) opts.all = true;
  if (project) opts.project = project;
  log(await summarizeSession(opts));
}
