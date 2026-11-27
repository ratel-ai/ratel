import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { SlackAppPort } from "@/lib/contracts/slack-app";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { slackCaller } from "./api";
import { SLACK_BOT_SCOPES, slackAppOf, slackAppStatus, slackManifestUrl } from "./app";
import { changeSlackApp, type SlackAppDeps } from "./app-actions";
import { forgetOrganization } from "./forget";
import { finishInstall, type InstallDeps, startInstall } from "./install";
import { makeState } from "./state";
import * as store from "./store";
import { fakeSlack } from "./test-support";

const KEY = "k".repeat(64);
const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "1234567890.0987654321";
const SECRET = "s3cretClientSecretValue0";
const TOKEN = "xoxb-s3cret-token";
const CODE = "s3cret-code";
const REDIRECT = "https://ratel.test/api/integrations/slack/callback";
const GRANTED = {
  ok: true,
  access_token: TOKEN,
  token_type: "bot",
  scope: SLACK_BOT_SCOPES.join(","),
  team: { id: "T1", name: "Acme" },
};
const SUBJECT = { actor: "ext", organizationId: ORG, projectId: PROJECT };

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: ReturnType<typeof getDb>;
let slack: Awaited<ReturnType<typeof fakeSlack>>;
const now = new Date("2026-11-24T10:00:00Z");
let seen: unknown[] = [];

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  slack = await fakeSlack();
});
beforeEach(async () => {
  await client.exec("delete from slack_apps; delete from slack_connections");
  seen = [];
  slack.received = [];
  slack.json(GRANTED);
});
after(async () => {
  slack.close();
  await client.close();
});

test("a full install exchanges the code and stores the team and a sealed token", async () => {
  await saveApp();
  const started = await startInstall(PROJECT, deps());
  assert.ok(started.ok);
  const consent = new URL(started.location);
  assert.equal(consent.origin + consent.pathname, `${slack.url}/oauth/v2/authorize`);
  assert.equal(consent.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(consent.searchParams.get("redirect_uri"), REDIRECT);
  assert.deepEqual(consent.searchParams.get("scope")?.split(","), [...SLACK_BOT_SCOPES]);
  assert.doesNotMatch(started.location, /s3cret/);

  const state = consent.searchParams.get("state");
  const finished = await finishInstall({ state, code: CODE, error: null }, deps());
  assert.deepEqual(finished, { ok: true, projectId: PROJECT, notice: "connected" });
  assert.deepEqual(slack.received, [
    {
      path: "/api/oauth.v2.access",
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`,
      params: { code: CODE, redirect_uri: REDIRECT },
    },
  ]);
  assert.deepEqual(await store.getSlackConnection(ORG, db, KEY), {
    teamId: "T1",
    teamName: "Acme",
    lost: false,
  });
  const sealed = await store.sealedSlackConnection(ORG, db);
  assert.ok(sealed && store.botTokenOf(sealed, KEY) === TOKEN);
  const rows = await client.query("select * from slack_connections, slack_apps");
  assert.doesNotMatch(JSON.stringify([rows.rows, seen]), /s3cret/);
  // Another key cannot open it: connect again.
  assert.equal((await store.getSlackConnection(ORG, db, "z".repeat(64)))?.lost, true);
});

test("a missing, changed, expired or foreign state stores nothing and calls nobody", async () => {
  await saveApp();
  const good = makeState(SUBJECT, now, KEY);
  const late = makeState(SUBJECT, new Date(now.getTime() - 10 * 60_000), KEY);
  const refused: [string | null, Partial<InstallDeps>?][] = [
    [null],
    ["x"],
    [`${good.slice(0, -4)}AAAA`],
    [makeState(SUBJECT, now, "z".repeat(64))],
    [late],
    [makeState({ ...SUBJECT, actor: "someone-else" }, now, KEY)],
    [makeState({ ...SUBJECT, organizationId: PROJECT }, now, KEY)],
    [good, { findProjectScope: async () => null }],
    [good, { getSession: async () => null }],
    [good, { enabled: async () => false }],
    [good, { isRestricted: async () => true }],
  ];
  for (const [state, over] of refused) {
    const result = await finishInstall({ state, code: CODE, error: null }, deps(over));
    assert.equal(result.ok, false, String(state));
  }
  assert.deepEqual(slack.received, []);
  assert.equal(await store.getSlackConnection(ORG, db, KEY), null);
  assert.ok((await finishInstall({ state: good, code: CODE, error: null }, deps())).ok);
});

test("a refusal by Slack is told without a secret, and nothing is stored", async () => {
  await saveApp();
  const cases: [unknown, Record<string, unknown>][] = [
    [
      { ok: false, error: "invalid_code" },
      { notice: "failed", code: "invalid_code" },
    ],
    [
      { ok: false, error: `bad ${SECRET} ${CODE}` },
      { notice: "failed", code: "bad_answer" },
    ],
    [{ ...GRANTED, refresh_token: "xoxe-s3cret" }, { notice: "rotation" }],
    [{ ...GRANTED, team: null, is_enterprise_install: true }, { notice: "no_workspace" }],
    [{ ...GRANTED, scope: "chat:write" }, { notice: "no_scopes" }],
  ];
  for (const [answer, outcome] of cases) {
    slack.json(answer);
    const state = makeState(SUBJECT, now, KEY);
    const result = await finishInstall({ state, code: CODE, error: null }, deps());
    assert.deepEqual(result, { ok: true, projectId: PROJECT, ...outcome });
  }
  const state = makeState(SUBJECT, now, KEY);
  const denied = await finishInstall({ state, code: null, error: "access_denied" }, deps());
  assert.ok(denied.ok && denied.notice === "denied");
  assert.equal(await store.getSlackConnection(ORG, db, KEY), null);
  assert.doesNotMatch(JSON.stringify(seen), /s3cret/);
});

test("start refuses without an app, without a key, and over a live connection only", async () => {
  const none = await startInstall(PROJECT, deps());
  assert.ok(!none.ok && none.status === 409);
  assert.match(none.error, /No Slack app is configured\..*organization settings/);
  const cloud = await startInstall(PROJECT, deps({ editionOwned: true }));
  assert.ok(!cloud.ok && cloud.error === "Slack is not available yet.");
  await saveApp();
  const keyless = await startInstall(PROJECT, deps({ canSeal: () => false }));
  assert.ok(!keyless.ok && /RATEL_SECRET_KEY/.test(keyless.error));
  await connect();
  const twice = await startInstall(PROJECT, deps());
  assert.ok(!twice.ok && /already connected/.test(twice.error));
  const sealed = await store.sealedSlackConnection(ORG, db);
  assert.ok(sealed);
  await store.markSlackLost(sealed, db);
  assert.ok((await startInstall(PROJECT, deps())).ok);
});

test("F447-1: a member cannot start or finish an install, and an admin can", async () => {
  await saveApp();
  for (const role of ["member", null] as const) {
    const over = { role: async () => role };
    const refused = {
      ok: false,
      status: 403,
      error: "Only an organization admin can connect Slack.",
    };
    assert.deepEqual(await startInstall(PROJECT, deps(over)), refused);
    const state = makeState(SUBJECT, now, KEY);
    assert.deepEqual(await finishInstall({ state, code: CODE, error: null }, deps(over)), refused);
  }
  assert.deepEqual(slack.received, []);
  assert.equal(await store.getSlackConnection(ORG, db, KEY), null);
  assert.ok((await startInstall(PROJECT, deps())).ok);
  const state = makeState(SUBJECT, now, KEY);
  assert.ok((await finishInstall({ state, code: CODE, error: null }, deps())).ok);
});

test("F447-4: each refused install ends its token in Slack", async () => {
  await saveApp();
  const bearer = `Bearer ${TOKEN}`;
  for (const answer of [
    { ...GRANTED, refresh_token: "xoxe-s3cret" },
    { ...GRANTED, team: null, is_enterprise_install: true },
    { ...GRANTED, scope: "chat:write" },
  ]) {
    slack.received = [];
    slack.json(answer);
    const state = makeState(SUBJECT, now, KEY);
    await finishInstall({ state, code: CODE, error: null }, deps());
    const revoked = slack.received.filter(({ path }) => path === "/api/auth.revoke");
    assert.deepEqual(
      revoked.map(({ authorization }) => authorization),
      [bearer],
    );
  }
  // A failed save, too: the error's type goes on, the token does not stay.
  slack.received = [];
  slack.json(GRANTED);
  await assert.rejects(
    finishInstall(
      { state: makeState(SUBJECT, now, KEY), code: CODE, error: null },
      deps({ save: async () => Promise.reject(new Error("no database")) }),
    ),
  );
  assert.deepEqual(slack.received.at(-1)?.path, "/api/auth.revoke");
  assert.doesNotMatch(JSON.stringify(seen), /s3cret/);
});

test("F447-4: two callbacks at one time leave one connection, and the other token ends", async () => {
  await saveApp();
  const both = async (tokens: [string, string]) => {
    await client.exec("delete from slack_connections");
    slack.received = [];
    let n = 0;
    slack.answer = (request, response) => {
      const token = request.path === "/api/oauth.v2.access" ? tokens[n++] : undefined;
      response.end(JSON.stringify(token ? { ...GRANTED, access_token: token } : { ok: true }));
    };
    // Both have read that nothing is connected before either saves.
    const over = { connection: async () => null };
    const results = await Promise.all(
      [0, 1].map(() =>
        finishInstall({ state: makeState(SUBJECT, now, KEY), code: CODE, error: null }, deps(over)),
      ),
    );
    assert.deepEqual(results.map((result) => result.ok && result.notice).sort(), [
      "already_connected",
      "connected",
    ]);
    const { rows } = await client.query("select 1 from slack_connections");
    assert.equal(rows.length, 1);
    const sealed = await store.sealedSlackConnection(ORG, db);
    assert.ok(sealed);
    const revoked = slack.received
      .filter(({ path }) => path === "/api/auth.revoke")
      .map(({ authorization }) => authorization.replace("Bearer ", ""));
    return { kept: store.botTokenOf(sealed, KEY), revoked };
  };
  const different = await both(["xoxb-s3cret-1", "xoxb-s3cret-2"]);
  assert.deepEqual([different.kept, ...different.revoked].sort(), [
    "xoxb-s3cret-1",
    "xoxb-s3cret-2",
  ]);
  // Slack may answer one token to both: it must not end.
  assert.deepEqual(await both([TOKEN, TOKEN]), { kept: TOKEN, revoked: [] });
});

test("a lost connection is replaced, also one that this key cannot open", async () => {
  await saveApp();
  await connect();
  assert.equal(await connect("xoxb-s3cret-new"), "taken");
  const sealed = await store.sealedSlackConnection(ORG, db);
  assert.ok(sealed);
  await store.markSlackLost(sealed, db);
  assert.equal(await connect("xoxb-s3cret-new"), "saved");
  assert.equal(await connect("xoxb-s3cret-other", "z".repeat(64)), "saved");
});

test("F447-3: an organization that is deleted leaves no connection and no app, and its token ends", async () => {
  const other = "33333333-3333-4333-8333-333333333333";
  await saveApp();
  await connect();
  await client.query(
    "insert into slack_apps select $1, client_id, sealed_secret, updated_by, updated_at from slack_apps",
    [other],
  );
  const workspace = {
    connection: (organizationId: string) => store.sealedSlackConnection(organizationId, db),
    markLost: (connection: store.SealedSlackConnection) => store.markSlackLost(connection, db),
    call: slackCaller(slack.url, 500),
    key: KEY,
  };
  // Slack refuses: the rows go all the same.
  slack.json({ ok: false, error: "invalid_auth" });
  await forgetOrganization(ORG, db, workspace);
  assert.deepEqual(
    slack.received.map(({ path, authorization }) => [path, authorization]),
    [["/api/auth.revoke", `Bearer ${TOKEN}`]],
  );
  assert.equal((await client.query("select 1 from slack_connections")).rows.length, 0);
  const apps = await client.query<{ organization_id: string }>("select * from slack_apps");
  assert.deepEqual(
    apps.rows.map((row) => row.organization_id),
    [other],
  );
  await forgetOrganization(ORG, db, workspace);
  assert.equal(slack.received.length, 1);
});

test("only an admin changes the app, and no answer holds its secret", async () => {
  const results = [
    await change({ action: "save", clientId: CLIENT_ID, clientSecret: SECRET }, { role: "member" }),
    await change({ action: "remove" }, { role: "member" }),
    await change({ action: "save", clientId: CLIENT_ID, clientSecret: SECRET }, { edition: true }),
    await change({ action: "save", clientId: "s3cret", clientSecret: SECRET }),
    await change({ action: "save", clientId: CLIENT_ID, clientSecret: "s3cret!" }),
    await change({ action: "nope" }),
  ];
  assert.deepEqual(
    results.map(({ ok }) => ok),
    Array(6).fill(false),
  );
  assert.equal(await store.savedClientId(ORG, db), null);
  const saved = await change({ action: "save", clientId: ` ${CLIENT_ID} `, clientSecret: SECRET });
  assert.deepEqual(saved, { ok: true });
  assert.deepEqual(await store.readSlackApp(ORG, db, KEY), {
    clientId: CLIENT_ID,
    clientSecret: SECRET,
  });
  assert.doesNotMatch(JSON.stringify([results, saved, seen]), /s3cret/);
  assert.ok((await change({ action: "remove" })).ok);
  assert.equal(await store.savedClientId(ORG, db), null);
});

test("an edition that supplies the app decides alone", async () => {
  const app = { clientId: CLIENT_ID, clientSecret: SECRET };
  let answer: typeof app | null = null;
  const port: SlackAppPort = { credentials: async () => answer };
  assert.deepEqual(await slackAppStatus(ORG, port), { kind: "edition", available: false });
  answer = app;
  assert.deepEqual(await slackAppStatus(ORG, port), { kind: "edition", available: true });
  assert.deepEqual(await slackAppOf(ORG, port), app);
});

test("the create-app link has the four scopes and this instance's callback", () => {
  const url = new URL(slackManifestUrl("Ratel", REDIRECT));
  assert.equal(url.origin + url.pathname, "https://api.slack.com/apps");
  const manifest = JSON.parse(url.searchParams.get("manifest_json") ?? "");
  assert.deepEqual(manifest.oauth_config, {
    redirect_urls: [REDIRECT],
    scopes: { bot: ["chat:write", "chat:write.public", "channels:read", "groups:read"] },
  });
  assert.equal(manifest.display_information.name, "Ratel");
});

function saveApp() {
  return store.saveSlackApp(
    { organizationId: ORG, clientId: CLIENT_ID, clientSecret: SECRET, actor: "ext", key: KEY },
    db,
  );
}

function connect(token = TOKEN, key = KEY) {
  return store.saveSlackConnection(
    { organizationId: ORG, teamId: "T1", teamName: "Acme", token, actor: "ext", key },
    db,
  );
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
    findProjectScope: async (id) => ({ project: { id }, organization: { id: ORG } }),
    enabled: async () => true,
    isRestricted: async () => false,
    role: async () => "admin",
    app: (organizationId) => store.readSlackApp(organizationId, db, KEY),
    connection: (organizationId) => store.getSlackConnection(organizationId, db, KEY),
    editionOwned: false,
    canSeal: () => true,
    call: slackCaller(slack.url, 500),
    save: (input) => store.saveSlackConnection({ ...input, key: KEY }, db),
    observe: async (fields) => {
      seen.push(fields);
    },
    redirectUrl: REDIRECT,
    slackUrl: slack.url,
    now: () => now,
    key: KEY,
    ...over,
  };
}

function change(
  input: Record<string, unknown>,
  { role = "admin", edition = false }: { role?: "admin" | "member"; edition?: boolean } = {},
) {
  const all: SlackAppDeps = {
    findOrganization: async () => ({
      organization: { id: ORG, name: "Acme", slug: "acme" },
      role,
      user: { externalId: "ext" },
    }),
    enabled: async () => true,
    editionOwned: () => edition,
    isRestricted: async () => false,
    canSeal: () => true,
    save: (app) => store.saveSlackApp({ ...app, key: KEY }, db),
    remove: (organizationId) => store.deleteSlackApp(organizationId, db),
    observe: async (fields) => {
      seen.push(fields);
    },
  };
  return changeSlackApp({ orgSlug: "acme", ...input }, all);
}
