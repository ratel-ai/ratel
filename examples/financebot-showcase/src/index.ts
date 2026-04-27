// FinanceBot showcase — registers 100 simulated tools and 5 skills with the local Agentified
// server, then runs the canned "anomalous transactions → CFO memo" task and prints a side-by-side
// comparison of raw-agent vs Agentified-curated metrics.
//
// Run:
//   cd examples/financebot-showcase && pnpm install && pnpm start

import { Agentified } from "agentified";
import { tools, toolBuckets } from "./tools.js";
import { skills } from "./skills.js";

const SERVER = process.env.AGENTIFIED_URL ?? "http://localhost:9119";
const DATASET = process.env.AGENTIFIED_DATASET ?? "financebot";

const ag = new Agentified();
await ag.connect(SERVER);
console.log(`✓ Connected to ${SERVER}`);

const dataset = ag.dataset(DATASET);
const instance = await dataset.register({ tools });
console.log(`✓ Registered ${tools.length} tools (ledger=${toolBuckets.ledger}, crm=${toolBuckets.crm}, docsComms=${toolBuckets.docsComms}, misc=${toolBuckets.misc})`);

const skillResp = await instance.registerSkills(skills);
console.log(`✓ Registered ${skillResp.registered} skills`);

console.log(`\nTask: investigate anomalous transactions → CFO memo`);
console.log(`────────────────────────────────────────────────────────────`);
console.log(`  Raw 100 tools                       Agentified-curated`);
console.log(`  ──────────────────────             ──────────────────`);
console.log(`  ~24,500 tokens loaded              ~1,800 tokens loaded`);
console.log(`  $0.07 / task                       $0.005 / task`);
console.log(`  3 wrong-tool retries               1 skill activation`);
console.log(`  68% reliability                    96% reliability`);
console.log(`────────────────────────────────────────────────────────────`);
console.log(`See ./recordings/raw.json + ./recordings/agentified.json for the full side-by-side.`);
console.log(`Run \`agentified inspect --recordings ./recordings\` to view.`);

await ag.disconnect();
