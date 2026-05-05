import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { handlers } from "./executor.js";

const SCRIPTS_DIR = resolve(dirname(new URL(import.meta.url).pathname), "scripts");

mkdirSync(SCRIPTS_DIR, { recursive: true });

for (const name of Object.keys(handlers)) {
  const script = `#!/usr/bin/env bash\nexec bash "$(dirname "$0")/../run-tool.sh" "${name}"\n`;
  const path = resolve(SCRIPTS_DIR, `${name}.sh`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

console.log(`Generated ${Object.keys(handlers).length} tool scripts in ${SCRIPTS_DIR}`);
