import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  CODE_HANDOFF_FLAG,
  codeHandoffEnabledFor,
  codeHandoffEnabledForActor,
} from "@/lib/views/code-handoff/gate";

const ORG = { id: "o1", name: "Acme", slug: "acme" };
const oss = (env: Record<string, string>) => ({ env, edition: "Ratel OSS", port: undefined });

/** A Cloud flags port that answers `answer` and records what it was asked. */
function cloud(answer: boolean | Error, env: Record<string, string> = {}) {
  const asked: [CoreFlag, FlagSubject][] = [];
  const port = {
    async enabled(flag: CoreFlag, subject: FlagSubject) {
      asked.push([flag, subject]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { asked, deps: { env, edition: "Ratel Cloud", port } };
}

test("FF_CODE_HANDOFF is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(CODE_HANDOFF_FLAG, "FF_CODE_HANDOFF");
  assert.ok((CORE_FLAGS as readonly string[]).includes(CODE_HANDOFF_FLAG));
});

test("OSS: off with nothing set; FF_CODE_HANDOFF or RATEL_EXPERIMENTAL_FEATURES turns it on", async () => {
  assert.equal(await codeHandoffEnabledFor(ORG, oss({})), false);
  assert.equal(await codeHandoffEnabledForActor("p1", "system:github-webhook", oss({})), false);
  assert.equal(await codeHandoffEnabledFor(ORG, oss({ FF_CODE_HANDOFF: "1" })), true);
  assert.equal(
    await codeHandoffEnabledForActor("p1", "project:p1", oss({ FF_CODE_HANDOFF: "1" })),
    true,
  );
  assert.equal(await codeHandoffEnabledFor(ORG, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })), true);
  assert.equal(await codeHandoffEnabledFor(ORG, oss({ FF_PIVOTS: "1" })), false);
});

test("Cloud: the port decides in the project's organization, for the person or a caller with no session", async () => {
  const on = cloud(true);
  assert.equal(await codeHandoffEnabledFor(ORG, on.deps, "user_1"), true);
  assert.equal(await codeHandoffEnabledForActor("p1", "system:github-webhook", on.deps), true);
  assert.deepEqual(on.asked, [
    ["FF_CODE_HANDOFF", { organizationId: "o1", actor: "user_1" }],
    ["FF_CODE_HANDOFF", { projectId: "p1", actor: "system:github-webhook" }],
  ]);
  assert.equal(await codeHandoffEnabledFor(ORG, cloud(false).deps), false);
});

test("Cloud: an operator's FF_CODE_HANDOFF comes first; a failed decision is off", async () => {
  const off = cloud(false, { FF_CODE_HANDOFF: "1" });
  assert.equal(await codeHandoffEnabledForActor("p1", "project:p1", off.deps), true);
  assert.deepEqual(off.asked, []);
  assert.equal(await codeHandoffEnabledFor(ORG, cloud(new Error("down")).deps), false);
});
