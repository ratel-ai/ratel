import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTALL_GRANT_TTL_MS,
  SETUP_STATE_TTL_MS,
  signInstallGrant,
  signSetupState,
  verifyInstallGrant,
  verifySetupState,
} from "./setup-state";

const SECRET = "test-webhook-secret";
const NOW = Date.parse("2026-11-17T10:00:00Z");
const STATE = { projectId: "11111111-1111-4111-8111-111111111111", externalId: "user_roberto" };

test("a state round-trips within its lifetime", () => {
  const token = signSetupState(STATE, SECRET, NOW);
  assert.deepEqual(verifySetupState(token, SECRET, NOW + SETUP_STATE_TTL_MS - 1), STATE);
});

test("an expired state is refused", () => {
  const token = signSetupState(STATE, SECRET, NOW);
  assert.equal(verifySetupState(token, SECRET, NOW + SETUP_STATE_TTL_MS), null);
});

test("a missing, malformed or forged state is refused", () => {
  const token = signSetupState(STATE, SECRET, NOW);
  const [body, signature] = token.split(".");
  const otherBody = Buffer.from(
    JSON.stringify({ p: "other", u: "user_roberto", e: NOW + 1e9 }),
  ).toString("base64url");
  for (const forged of [
    null,
    undefined,
    "",
    body,
    `${body}.`,
    `${otherBody}.${signature}`,
    `${token}.x`,
    "a.b",
  ]) {
    assert.equal(verifySetupState(forged, SECRET, NOW), null, String(forged));
  }
  assert.equal(verifySetupState(signSetupState(STATE, "another-secret", NOW), SECRET, NOW), null);
});

test("a grant round-trips and expires", () => {
  const grant = { ...STATE, installationIds: [4242, 7] };
  const token = signInstallGrant(grant, SECRET, NOW);
  assert.deepEqual(verifyInstallGrant(token, SECRET, NOW + INSTALL_GRANT_TTL_MS - 1), grant);
  assert.equal(verifyInstallGrant(token, SECRET, NOW + INSTALL_GRANT_TTL_MS), null);
});

test("a state never passes as a grant, nor a grant as a state", () => {
  const state = signSetupState(STATE, SECRET, NOW);
  const grant = signInstallGrant({ ...STATE, installationIds: [1] }, SECRET, NOW);
  assert.equal(verifyInstallGrant(state, SECRET, NOW), null);
  assert.equal(verifySetupState(grant, SECRET, NOW), null);
});
