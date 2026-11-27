import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import { composition } from "@/lib/composition";
import type { EditionUi } from "@/lib/contracts/composition";
import type { SharedHealth } from "@/lib/views/health/shared-load";
import { recordSharedHealthView, sharedHealthFor } from "@/lib/views/health/shared-page-load";

/**
 * The public share pages answer 404 whenever this returns null. The pages themselves import a
 * stylesheet, so they cannot be loaded here; what decides the 404 can.
 */

type Share = NonNullable<EditionUi["HealthShare"]>;

const NoDialog = () => null;
const editionUi = composition.ui;
const databaseUrl = process.env.DATABASE_URL;

function withShare(share: Partial<Share>): void {
  composition.ui = async () =>
    ({
      HealthShare: {
        load: async () => ({ link: null, canManage: false }),
        Dialog: NoDialog,
        resolve: async () => null,
        recordView: async () => {},
        ...share,
      },
    }) as unknown as EditionUi;
}

beforeEach(() => {
  // Never connected to: every case below stops before a query.
  process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
  resetConfigForTests();
});

afterEach(() => {
  composition.ui = editionUi;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  resetConfigForTests();
});

test("without a database every link is unknown", async () => {
  delete process.env.DATABASE_URL;
  resetConfigForTests();
  let asked = false;
  withShare({
    resolve: async () => {
      asked = true;
      return null;
    },
  });
  assert.equal(await sharedHealthFor("tok"), null);
  assert.equal(asked, false);
});

test("an edition without share links, the open-source one, answers every token as unknown", async () => {
  composition.ui = undefined;
  assert.equal(await sharedHealthFor("tok"), null);
  composition.ui = async () => ({}) as EditionUi;
  assert.equal(await sharedHealthFor("tok"), null);
});

test("a token the edition does not know is unknown, and it was asked with the token as given", async () => {
  const asked: string[] = [];
  withShare({
    resolve: async (token) => {
      asked.push(token);
      return null;
    },
  });
  assert.equal(await sharedHealthFor("tok-1"), null);
  assert.deepEqual(asked, ["tok-1"]);
});

test("a failing lookup is answered like an unknown link, never as an error", async () => {
  withShare({
    resolve: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(await sharedHealthFor("tok"), null);
});

test("counting a view goes to the edition with the link, and a failure there is swallowed", async () => {
  const shared = { linkId: "link-1", projectId: "project-1" } as SharedHealth;
  const counted: string[] = [];
  withShare({
    recordView: async (linkId) => {
      counted.push(linkId);
    },
  });
  await recordSharedHealthView(shared);
  assert.deepEqual(counted, ["link-1"]);

  withShare({
    recordView: async () => {
      throw new Error("connection refused");
    },
  });
  await recordSharedHealthView(shared);
});
