// Capture what Ratel Cloud answers for every parity subject (temporary parity harness, RTL-45).
//
//   RATEL_CLOUD_DIR=/path/to/ratel-cloud pnpm parity:capture
//
// Runs with the Cloud checkout's apps/web as the working directory, so '@/…' in
// cloud-subjects.mts resolves to Cloud's code (tsx reads that directory's tsconfig). Refuses to
// run unless the checkout is at the commit in scripts/platform-sync/source.json: the captured
// files are "Cloud at that commit", and nothing else may be written under that name. Writes one
// JSON file per subject to apps/web/parity/golden/, and refuses to write any file that trips the
// private-strings guard, since the files are committed to the open-source tree.
//
// CI never runs this: it has no Cloud checkout. It compares against the committed files.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateStrings, loadPatterns } from "../platform-sync/private-strings.mjs";
import { cloudCheckout } from "./cloud-checkout.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, "apps", "web", "parity", "golden");

function fail(message: string): never {
  console.error(`parity capture: ${message}`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "platform-sync", "source.json"), "utf8")) as { commit: string };
let cloudRoot: string;
try {
  cloudRoot = cloudCheckout(process.env.RATEL_CLOUD_DIR, source.commit);
} catch (error) {
  fail((error as Error).message);
}
const cloudApp = join(cloudRoot, "apps", "web");
if (realpathSync(process.cwd()) !== realpathSync(cloudApp)) {
  fail(`run from ${cloudApp} so '@/…' resolves to Cloud's code (pnpm parity:capture does).`);
}

// Nothing a subject does may reach a model, a database or a vendor.
for (const name of Object.keys(process.env)) {
  if (/(_API_KEY|_SECRET|_TOKEN)$/.test(name) || name === "DATABASE_URL") delete process.env[name];
}

const { cloudSubjects } = await import("./cloud-subjects.mts");
const subjects = await cloudSubjects();

const patterns = loadPatterns(join(REPO_ROOT, "scripts", "platform-sync", "private-strings.txt"));
const files = Object.entries(subjects).map(([subject, value]) => ({
  subject,
  path: join(GOLDEN_DIR, `${subject}.json`),
  text: `${JSON.stringify({ subject, cloudCommit: source.commit, value }, null, 2)}\n`,
}));
const refused = files.flatMap((file) => findPrivateStrings(file.text, patterns).map((hit) => ({ ...hit, subject: file.subject })));
if (refused.length > 0) {
  for (const hit of refused) console.error(`parity capture: ${hit.subject}.json line ${hit.line} matches ${hit.pattern}`);
  fail("refusing to write: a captured file holds a private string. Narrow the subject so it does not carry it.");
}

mkdirSync(GOLDEN_DIR, { recursive: true });
for (const file of files) writeFileSync(file.path, file.text);
console.log(`parity capture: wrote ${files.length} subjects from ratel-cloud ${source.commit.slice(0, 8)} to apps/web/parity/golden/`);
process.exit(0);
