#!/usr/bin/env node
import { runCli } from "./cli.js";

async function main() {
  const { shutdown } = await runCli(process.argv.slice(2));

  let shuttingDown = false;
  const onSignal = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[ratel] received ${signal}, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error(`[ratel] shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

main().catch((err) => {
  console.error(`[ratel] ${(err as Error).message}`);
  process.exit(1);
});
