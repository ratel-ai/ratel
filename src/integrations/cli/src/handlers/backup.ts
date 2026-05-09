import { ArgError } from "../args.js";
import { runListBackups } from "./list.js";
import type { HandlerCtx } from "./types.js";
import { runUndo } from "./undo.js";

export const BACKUP_USAGE = `usage: ratel backup <verb> [args...]

Verbs:
  list    list backup sets under ~/.ratel/backups/`;

export async function runBackup(ctx: HandlerCtx): Promise<void> {
  switch (ctx.argv.verb) {
    case "list":
      await runListBackups(ctx);
      return;
    case "undo":
      await runUndo(ctx);
      return;
    default:
      throw new ArgError(`unknown backup verb: ${ctx.argv.verb}`);
  }
}
