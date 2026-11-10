// N drain ticks on $DATABASE_URL, the way scripts/seed.mts drains (temporary parity harness,
// RTL-45). Run with apps/web as the working directory. Prints the last tick's heartbeat keys.
const ticks = Number(process.argv[2] ?? 8);
const { runDrainTick } = await import("@/lib/jobs/drain");
for (let i = 0; i < ticks; i++) {
  const tick = await runDrainTick();
  console.log(`tick ${i + 1}: ok=${tick.ok} done=${tick.done} failed=${tick.failed}${tick.error ? ` error=${tick.error}` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
process.exit(0);
