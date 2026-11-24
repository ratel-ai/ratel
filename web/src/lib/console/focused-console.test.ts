import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { focusedConsoleEnabled, focusedConsoleOrganizationIds } from "./focused-console";

const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];
const withConfig = (config: ReturnType<typeof resolveConfig>) =>
  focusedConsoleOrganizationIds(ORGANIZATIONS, (organization) =>
    focusedConsoleEnabled(organization, config),
  );

test("focusedConsole is off by default, and FF_FOCUSED_CONSOLE turns it on", async () => {
  assert.deepEqual(await withConfig(resolveConfig({ env: {} })), []);
  assert.deepEqual(await withConfig(resolveConfig({ env: { FF_FOCUSED_CONSOLE: "1" } })), [
    "org-1",
    "org-2",
  ]);
});

test("a failed decision keeps today's rail for that organization only", async () => {
  const ids = await focusedConsoleOrganizationIds(ORGANIZATIONS, async ({ id }) => {
    if (id === "org-1") throw new Error("flag service down");
    return true;
  });
  assert.deepEqual(ids, ["org-2"]);
});

test("the flag decides when it is set; unset, the experimental umbrella does", async () => {
  const cases = [
    { flag: undefined, umbrella: "0", on: false },
    { flag: undefined, umbrella: "1", on: true },
    { flag: "1", umbrella: "0", on: true },
    { flag: "1", umbrella: "1", on: true },
    { flag: "0", umbrella: "0", on: false },
    { flag: "0", umbrella: "1", on: false },
  ];
  for (const { flag, umbrella, on } of cases) {
    const config = resolveConfig({
      env: {
        RATEL_EXPERIMENTAL_FEATURES: umbrella,
        ...(flag === undefined ? {} : { FF_FOCUSED_CONSOLE: flag }),
      },
    });
    assert.equal(
      await focusedConsoleEnabled({ id: "org-1" }, config),
      on,
      `FF_FOCUSED_CONSOLE=${flag} RATEL_EXPERIMENTAL_FEATURES=${umbrella}`,
    );
  }
});
