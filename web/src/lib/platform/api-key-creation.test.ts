import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposition } from "@/lib/composition/ports";
import {
  type ApiKeyCreationDeps,
  apiKeyCreationRefusal,
  apiKeysBlockedUntil,
  keysBlockedMessage,
} from "./api-key-creation";

const ORG = "22222222-2222-4222-8222-222222222222";
const UNTIL = new Date("2026-12-09T20:30:00Z");

function deps(until: Date | null | Error, now: string, onHold = false): ApiKeyCreationDeps {
  return {
    port: {
      blockedUntil: async () => {
        if (until instanceof Error) throw until;
        return until;
      },
    },
    now: () => new Date(now),
    onHold: async () => onHold,
  };
}

test("blocked until the date, in plain words, and lifted by itself", async () => {
  const before = deps(UNTIL, "2026-12-09T20:29:59Z");
  assert.equal(await apiKeysBlockedUntil(ORG, before), UNTIL);
  assert.equal(
    await apiKeyCreationRefusal(ORG, undefined, before),
    "New API keys become available on 9 December 2026 at 20:30 UTC. This workspace moved recently. Existing keys keep working.",
  );
  assert.equal(keysBlockedMessage(UNTIL), await apiKeyCreationRefusal(ORG, undefined, before));
  const after = deps(UNTIL, "2026-12-09T20:30:00Z");
  assert.equal(await apiKeysBlockedUntil(ORG, after), null);
  assert.equal(await apiKeyCreationRefusal(ORG, undefined, after), null);
  assert.equal(
    await apiKeyCreationRefusal(ORG, undefined, deps(null, "2026-12-01T00:00:00Z")),
    null,
  );
});

test("no key while the workspace is on hold, or when the check fails", async () => {
  assert.match(
    (await apiKeyCreationRefusal(ORG, "p", deps(null, "2026-12-01T00:00:00Z", true))) ?? "",
    /not open yet/,
  );
  assert.match(
    (await apiKeyCreationRefusal(ORG, "p", deps(new Error("db down"), "2026-12-01T00:00:00Z"))) ??
      "",
    /Try again shortly/,
  );
});

test("the open-source edition never blocks", async () => {
  assert.equal(createComposition("oss").apiKeyCreation, undefined);
  assert.equal(
    await apiKeyCreationRefusal(ORG, undefined, { port: undefined, onHold: async () => false }),
    null,
  );
});
