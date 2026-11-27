import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A fixture diff, as `git diff` prints it. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
