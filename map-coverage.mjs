// For each file changed base..head, print the map.json entry that covers it (exact file or folder entry).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [base, head] = process.argv.slice(2);
const map = JSON.parse(readFileSync("scripts/platform-sync/map.json", "utf8"));
const files = execFileSync("git", ["diff", "--name-only", `${base}..${head}`], { encoding: "utf8" }).trim().split("\n");
let missing = 0;
for (const file of files) {
  if (file === "scripts/platform-sync/map.json") { console.log(`${file}\n    -> the map itself`); continue; }
  const hits = map.entries.filter((e) => e.to && (e.to === file || file.startsWith(`${e.to}/`)));
  const best = hits.sort((a, b) => b.to.length - a.to.length)[0];
  if (!best) { missing++; console.log(`${file}\n    -> NOT COVERED`); continue; }
  console.log(`${file}\n    -> ${best.mode}${best.to === file ? "" : " (folder entry)"}: ${best.from} -> ${best.to}${best.$why ? `\n       $why: ${best.$why}` : ""}`);
}
console.log(`\n${files.length} changed files, ${missing} not covered`);
process.exit(missing ? 1 : 0);
