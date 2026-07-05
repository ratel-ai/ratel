import { listBackups, restoreLatest } from "../backup.js";
import type { HandlerCtx } from "./types.js";

export async function runUndo(ctx: HandlerCtx): Promise<void> {
  const all = await listBackups(ctx.env, ctx.fs);
  if (all.length === 0) {
    ctx.log("nothing to undo");
    return;
  }
  const latest = all[0];
  const answer = await ctx.prompts.confirm({
    message: `Restore ${latest.entries.length} file(s) from ${latest.createdAt} (${latest.action})?`,
    initialValue: true,
  });
  if (ctx.prompts.isCancel(answer) || answer === false) {
    ctx.log("undo cancelled");
    return;
  }
  const restored = await restoreLatest(ctx.env, ctx.fs);
  if (!restored) return;
  for (const e of restored.entries) {
    ctx.log(`restored ${e.originalPath}`);
  }
}
