import assert from "node:assert/strict";
import { test } from "node:test";
import { movedPageDestination } from "@/lib/console/scope/moved-pages";

const P = "11111111-2222-4333-8444-555555555555";
const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const at = (path: string) =>
  movedPageDestination(new URL(`https://cloud.test/project/${P}${path}`));

test("pages folded into one product answer with their new home", () => {
  assert.equal(at("/improvement"), `/project/${P}/improvement/fixes`);
  assert.equal(
    at("/improvement?tab=intents&sstatus=open"),
    `/project/${P}/improvement/fixes`,
    "retired tab params are dropped",
  );
  assert.equal(at("/improvement/match-quality"), `/project/${P}/quality/descriptions`);
  assert.equal(
    at(`/quality/suggestions?peek=${U}`),
    `/project/${P}/quality/descriptions?peek=rewrite%3A${U}`,
  );
  assert.equal(
    at("/quality/suggestions?peek=not-an-id"),
    `/project/${P}/quality/descriptions`,
    "only a proposal id survives the move",
  );
  assert.equal(
    at(`/improvement/tool-explorer/suggestions?peek=${U}`),
    `/project/${P}/improvement/fixes?peek=craft%3A${U}`,
  );
  assert.equal(at("/improvement/tool-explorer"), `/project/${P}/health/tasks`);
  assert.equal(at("/improvement/tool-explorer?view=crafts"), `/project/${P}/improvement/fixes`);
  assert.equal(
    at("/improvement/tool-explorer/sessions/s-1?tools=a,b"),
    `/project/${P}/health/tasks/sessions/s-1?tools=a%2Cb`,
  );
  assert.equal(at("/intents/asks?peek=intent_3&sort=label"), `/project/${P}/intents?peek=intent_3`);
  assert.equal(at("/dashboards"), `/project/${P}?peek=context`);
  assert.equal(at("/runtime-events?type=search"), `/project/${P}/settings/developer?type=search`);
});

test("what needs the database, or never moved, is left to the page", () => {
  assert.equal(
    at(`/improvement/tool-explorer?ask=${U}`),
    null,
    "an old ask is mapped to its task by the page",
  );
  assert.equal(at(`/improvement/tool-explorer?peek=${U}`), null);
  assert.equal(at("/improvement/fixes"), null);
  assert.equal(at("/intents"), null);
  assert.equal(at("/health/tasks"), null);
  assert.equal(at("/quality"), null);
  assert.equal(
    at("/quality/descriptions?tool=lookup_order"),
    null,
    "Descriptions is the new home, not a move",
  );
  assert.equal(
    movedPageDestination(new URL(`https://cloud.test/project/not-a-uuid/improvement`)),
    null,
  );
  assert.equal(movedPageDestination(new URL("https://cloud.test/improvement")), null);
});
