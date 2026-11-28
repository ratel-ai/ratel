import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * The snapshot rule of `vm-session.ts` holds only when the code of a job or a run reaches a VM
 * through a `VmSession`. This test reads the source of the feature and fails on a call that goes
 * round the session: a `startVm`, a `saveSnapshot` or a `writeFile` of the provider. Only the
 * session itself, the adapters (the providers) and the tests call the provider so.
 */
const ROOT = join(import.meta.dirname, "..");
const EXEMPT = ["adapters/", "tests/", "vm-session.ts"];
/** A start of a VM goes through `startVmSession`: a session has no `startVm`. */
const START = /\.\s*startVm\b/;
/** A snapshot or a file write on a value whose name holds "provider". */
const ON_PROVIDER =
  /provider\w*\)?\s*\??\.\s*(saveSnapshot|writeFile)\b|\b(saveSnapshot|writeFile)\s*[,}][^;]*=\s*[\w.]*provider/i;

test("no code of a job or a run calls startVm, saveSnapshot or writeFile of the provider", () => {
  const found = sourceFiles(ROOT)
    .map((path) => relative(ROOT, path))
    .filter((path) => !EXEMPT.some((exempt) => path.startsWith(exempt)))
    .flatMap((path) =>
      bypassesIn(readFileSync(join(ROOT, path), "utf8")).map((at) => `${path}:${at}`),
    );
  assert.deepEqual(found, []);
});

test("the scan finds a call that goes round the session", () => {
  assert.deepEqual(bypassesIn("await deps.provider.saveSnapshot(vmRef, name);"), [1]);
  assert.deepEqual(bypassesIn("await provider.writeFile(vmRef, request);"), [1]);
  assert.deepEqual(bypassesIn("x;\nconst { vmRef } = await provider.startVm(request);"), [2]);
  assert.deepEqual(bypassesIn("const { saveSnapshot } = deps.provider;"), [1]);
  assert.deepEqual(bypassesIn("await vm.saveSnapshot('rv-1');\nawait vm.writeFile(file);"), []);
});

/** The lines (from 1) that call the provider round the session. */
function bypassesIn(source: string): number[] {
  return source.split("\n").flatMap((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    return START.test(code) || ON_PROVIDER.test(code) ? [index + 1] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}
