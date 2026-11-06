import assert from "node:assert/strict";
import { test } from "node:test";
import { envVarNameForFlagKey, flagEnvEnabled, parseFlagEnvValue } from "@/lib/platform/flags-env";

test("flag environment values accept documented boolean spellings", () => {
  assert.deepEqual(
    [" true ", "TRUE", "1", " false ", "FALSE", "0", "yes", undefined].map(parseFlagEnvValue),
    [true, true, true, false, false, false, undefined, undefined],
  );
});

test("boot gates enable only explicit true flag values", () => {
  assert.equal(flagEnvEnabled("true"), true);
  assert.equal(flagEnvEnabled("1"), true);
  assert.equal(flagEnvEnabled("false"), false);
  assert.equal(flagEnvEnabled(undefined), false);
});

test("cloud self-telemetry maps to the boot gate environment name", () => {
  assert.equal(envVarNameForFlagKey("cloud-self-telemetry"), "FF_CLOUD_SELF_TELEMETRY");
});
