import { listBackups } from "../backup.js";
import type { HandlerCtx } from "./types.js";

export async function runListBackups(ctx: HandlerCtx): Promise<void> {
  const all = await listBackups(ctx.env, ctx.fs);
  if (all.length === 0) {
    ctx.log("no backups under ~/.ratel/backups/");
    return;
  }
  for (const m of all) {
    const count = m.entries.length;
    ctx.log(`${m.createdAt}  ${m.action}  ${count} file${count === 1 ? "" : "s"}`);
  }
}
