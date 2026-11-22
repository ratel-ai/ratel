import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createFakeGitHub, type FakeGitHub } from "./fake-github";
import {
  completeSetup,
  type LinkServiceDeps,
  linkProjectRepo,
  listGrantRepos,
  startInstall,
  unlinkProjectRepo,
} from "./link-service";
import {
  INSTALL_GRANT_TTL_MS,
  SETUP_STATE_TTL_MS,
  signInstallGrant,
  signSetupState,
} from "./setup-state";
import { type CodeHandoffDb, getRepoLink, linkRepo, unlinkRepo } from "./store";

const ORG = "22222222-2222-4222-8222-222222222221";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "11111111-1111-4111-8111-111111111112";
const SECRET = "test-webhook-secret";
const USER = "user_roberto";
const START = Date.parse("2026-11-17T10:00:00Z");
/** Roberto's own installation. */
const OWN = 77;
/** Another customer's installation, changed a second ago. */
const FOREIGN = 88;
const OWN_CODE = "code-roberto";
const OWN_TOKEN = "ghu_user_token_roberto";

interface Harness {
  client: PGlite;
  db: CodeHandoffDb;
  github: FakeGitHub;
  clock: { now: number };
  events: { event: string; projectId: string }[];
  logs: string[];
  /** Every GitHub call the service made, by name. */
  calls: string[];
  deps: (overrides?: Partial<LinkServiceDeps>) => LinkServiceDeps;
}

async function setup(): Promise<Harness> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${P1}', '${ORG}', 'A', 'a'), ('${P2}', '${ORG}', 'B', 'b');
  `);
  const db = drizzle(client, { schema }) as unknown as CodeHandoffDb;
  const fake = createFakeGitHub();
  fake.addRepo(OWN, { id: 501, owner: "acme", name: "agent", defaultBranch: "main" });
  fake.addRepo(OWN, { id: 502, owner: "acme", name: "site", defaultBranch: "trunk" });
  fake.addRepo(FOREIGN, { id: 901, owner: "victim", name: "private-agent", defaultBranch: "main" });
  fake.addUser({ code: OWN_CODE, token: OWN_TOKEN, installationIds: [OWN] });
  const calls: string[] = [];
  const github = new Proxy(fake, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  }) as FakeGitHub;
  const clock = { now: START };
  const events: Harness["events"] = [];
  const logs: string[] = [];
  const deps = (overrides: Partial<LinkServiceDeps> = {}): LinkServiceDeps => ({
    secret: SECRET,
    github,
    projectAccess: async () => ({ organizationId: ORG }),
    isRestricted: async () => false,
    getRepoLink: (projectId) => getRepoLink(projectId, db),
    linkRepo: (link) => linkRepo(link, db),
    unlinkRepo: (projectId) => unlinkRepo(projectId, db),
    track: async (event, context) => {
      events.push({ event, projectId: context.projectId });
    },
    log: (fields, message) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
    now: () => clock.now,
    ...overrides,
  });
  return { client, db, github, clock, events, logs, calls, deps };
}

async function rowCount(client: PGlite): Promise<number> {
  const result = await client.query<{ n: number }>("select count(*)::int as n from repo_links");
  return result.rows[0].n;
}

/** Install → GitHub's redirect with the person's code: the grant the picker uses. */
async function installAndReturn(
  h: Harness,
  options: { installationId?: string | null; projectId?: string } = {},
): Promise<string> {
  const projectId = options.projectId ?? P1;
  const started = await startInstall({ projectId, externalId: USER }, h.deps());
  assert.ok(started.ok);
  h.clock.now += 60_000;
  const installationId =
    options.installationId === undefined ? String(OWN) : options.installationId;
  const result = await completeSetup(
    {
      state: started.state,
      cookieState: started.state,
      code: OWN_CODE,
      installationId,
      externalId: USER,
    },
    h.deps(),
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.grant;
}

test("regression: a valid state with a fresh foreign installation id is refused before any repo is listed or written", async () => {
  const h = await setup();
  try {
    const started = await startInstall({ projectId: P1, externalId: USER }, h.deps());
    assert.ok(started.ok);
    const result = await completeSetup(
      {
        state: started.state,
        cookieState: started.state,
        code: OWN_CODE,
        installationId: String(FOREIGN),
        externalId: USER,
      },
      h.deps(),
    );
    assert.deepEqual(result, { ok: false, error: "unverified_installation", projectId: P1 });
    assert.deepEqual(h.calls, ["exchangeUserCode", "listUserInstallations"]);
    assert.equal(await rowCount(h.client), 0);

    // A grant can only come from the setup route; a hand-made one under another key is refused.
    const forged = signInstallGrant(
      { projectId: P1, externalId: USER, installationIds: [FOREIGN] },
      "another-secret",
      h.clock.now,
    );
    assert.deepEqual(await listGrantRepos({ projectId: P1, externalId: USER }, forged, h.deps()), {
      ok: false,
      error: "invalid_grant",
    });
    assert.deepEqual(
      await linkProjectRepo(
        { projectId: P1, externalId: USER },
        { grant: forged, repoId: 901 },
        h.deps(),
      ),
      { ok: false, error: "invalid_grant" },
    );
    assert.ok(!h.calls.includes("listInstallationRepos"));
    assert.equal(await rowCount(h.client), 0);
  } finally {
    await h.client.close();
  }
});

test("a grant is issued only for installations in the person's GET /user/installations", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h);
    const listed = await listGrantRepos({ projectId: P1, externalId: USER }, grant, h.deps());
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.repos.map((repo) => [repo.installationId, repo.fullName]),
      [
        [OWN, "acme/agent"],
        [OWN, "acme/site"],
      ],
    );
    assert.deepEqual(
      await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 901 }, h.deps()),
      { ok: false, error: "repo_not_found" },
    );
  } finally {
    await h.client.close();
  }
});

test("without installation_id (an App already installed) the grant holds all of the person's installations", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h, { installationId: null });
    const listed = await listGrantRepos({ projectId: P1, externalId: USER }, grant, h.deps());
    assert.ok(listed.ok);
    assert.equal(listed.repos.length, 2);
  } finally {
    await h.client.close();
  }
});

test("a code GitHub refuses, a missing code, or a person with no installation gets no grant", async () => {
  const h = await setup();
  try {
    const started = await startInstall({ projectId: P1, externalId: USER }, h.deps());
    assert.ok(started.ok);
    for (const code of [null, "", "not-a-code"]) {
      assert.deepEqual(
        await completeSetup(
          {
            state: started.state,
            cookieState: started.state,
            code,
            installationId: String(OWN),
            externalId: USER,
          },
          h.deps(),
        ),
        { ok: false, error: "unverified_installation", projectId: P1 },
      );
    }
    h.github.addUser({ code: "code-empty", token: "ghu_empty", installationIds: [] });
    assert.deepEqual(
      await completeSetup(
        {
          state: started.state,
          cookieState: started.state,
          code: "code-empty",
          installationId: null,
          externalId: USER,
        },
        h.deps(),
      ),
      { ok: false, error: "unknown_installation", projectId: P1 },
    );
  } finally {
    await h.client.close();
  }
});

test("the user token is not stored, returned or logged", async () => {
  const h = await setup();
  try {
    const started = await startInstall({ projectId: P1, externalId: USER }, h.deps());
    assert.ok(started.ok);
    const ok = await completeSetup(
      {
        state: started.state,
        cookieState: started.state,
        code: OWN_CODE,
        installationId: String(OWN),
        externalId: USER,
      },
      h.deps(),
    );
    h.github.addUser({ code: OWN_CODE, token: OWN_TOKEN, installationIds: [OWN] });
    const refused = await completeSetup(
      {
        state: started.state,
        cookieState: started.state,
        code: OWN_CODE,
        installationId: String(FOREIGN),
        externalId: USER,
      },
      h.deps(),
    );
    assert.deepEqual(h.github.tokensIssued, [OWN_TOKEN, OWN_TOKEN]);
    assert.ok(h.logs.length >= 2, "the service logs each outcome");
    for (const text of [JSON.stringify(ok), JSON.stringify(refused), ...h.logs]) {
      assert.ok(!text.includes(OWN_TOKEN), text);
      assert.ok(!text.includes(OWN_CODE), text);
    }
    if (ok.ok)
      assert.ok(!Buffer.from(ok.grant.split(".")[0], "base64url").toString().includes(OWN_TOKEN));
    const stored = await h.client.query("select * from repo_links");
    assert.ok(!JSON.stringify(stored.rows).includes(OWN_TOKEN));
  } finally {
    await h.client.close();
  }
});

test("install, pick, link, unlink: a row exists then goes; a repeated link of the same repo emits no second repo_linked", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h);
    assert.ok(
      (await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 502 }, h.deps()))
        .ok,
    );
    const row = await getRepoLink(P1, h.db);
    assert.deepEqual(
      [row?.owner, row?.name, row?.defaultBranch, row?.installationId, row?.linkedBy],
      ["acme", "site", "trunk", OWN, USER],
    );

    assert.ok(
      (await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 502 }, h.deps()))
        .ok,
    );
    assert.deepEqual(
      h.events.map((e) => e.event),
      ["repo_linked"],
    );
    assert.ok(
      (await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 501 }, h.deps()))
        .ok,
    );
    assert.deepEqual(
      h.events.map((e) => e.event),
      ["repo_linked", "repo_linked"],
    );

    assert.deepEqual(await unlinkProjectRepo({ projectId: P1, externalId: USER }, h.deps()), {
      ok: true,
      removed: true,
    });
    assert.equal(await rowCount(h.client), 0);
    assert.deepEqual(await unlinkProjectRepo({ projectId: P1, externalId: USER }, h.deps()), {
      ok: true,
      removed: false,
    });
    assert.deepEqual(
      h.events.map((e) => e.event),
      ["repo_linked", "repo_linked", "repo_unlinked"],
    );
  } finally {
    await h.client.close();
  }
});

test("setup with a forged, expired, missing or someone else's state writes nothing and asks GitHub nothing", async () => {
  const h = await setup();
  try {
    const forged = signSetupState({ projectId: P1, externalId: USER }, "another-secret", START);
    const expired = signSetupState(
      { projectId: P1, externalId: USER },
      SECRET,
      START - SETUP_STATE_TTL_MS - 1,
    );
    const other = signSetupState({ projectId: P1, externalId: "user_mallory" }, SECRET, START);
    const cases: [string | null, string][] = [
      [forged, "invalid_state"],
      [expired, "invalid_state"],
      [null, "invalid_state"],
      [other, "wrong_user"],
    ];
    for (const [state, error] of cases) {
      assert.deepEqual(
        await completeSetup(
          {
            state,
            cookieState: state,
            code: OWN_CODE,
            installationId: String(OWN),
            externalId: USER,
          },
          h.deps(),
        ),
        { ok: false, error },
      );
    }
    assert.deepEqual(h.calls, []);
    assert.equal(await rowCount(h.client), 0);
  } finally {
    await h.client.close();
  }
});

test("login CSRF: setup refuses a URL state that is missing or differs from the install cookie, before asking GitHub", async () => {
  const h = await setup();
  try {
    const started = await startInstall({ projectId: P1, externalId: USER }, h.deps());
    assert.ok(started.ok);
    h.clock.now += 1;
    const other = await startInstall({ projectId: P2, externalId: USER }, h.deps());
    assert.ok(other.ok);
    const ATTACKER_CODE = "code-mallory";
    h.github.addUser({ code: ATTACKER_CODE, token: "ghu_mallory", installationIds: [FOREIGN] });
    const cases: [string | null, string | null][] = [
      [null, started.state],
      ["", started.state],
      [other.state, started.state],
      [started.state, null],
      [started.state, other.state],
    ];
    for (const [state, cookieState] of cases) {
      const result = await completeSetup(
        {
          state,
          cookieState,
          code: ATTACKER_CODE,
          installationId: String(FOREIGN),
          externalId: USER,
        },
        h.deps(),
      );
      assert.deepEqual(
        result,
        { ok: false, error: "invalid_state" },
        JSON.stringify([state, cookieState]),
      );
    }
    assert.ok(!h.calls.includes("exchangeUserCode"), JSON.stringify(h.calls));
  } finally {
    await h.client.close();
  }
});

test("a user without access to the project cannot install, set up or link", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h);
    const noAccess = h.deps({ projectAccess: async () => null });
    assert.deepEqual(await startInstall({ projectId: P1, externalId: USER }, noAccess), {
      ok: false,
      error: "forbidden",
    });
    const state = signSetupState({ projectId: P1, externalId: USER }, SECRET, h.clock.now);
    assert.deepEqual(
      await completeSetup(
        {
          state,
          cookieState: state,
          code: OWN_CODE,
          installationId: String(OWN),
          externalId: USER,
        },
        noAccess,
      ),
      { ok: false, error: "forbidden", projectId: P1 },
    );
    assert.deepEqual(
      await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 501 }, noAccess),
      { ok: false, error: "forbidden" },
    );
    assert.deepEqual(await unlinkProjectRepo({ projectId: P1, externalId: USER }, noAccess), {
      ok: false,
      error: "forbidden",
    });
    assert.equal(await rowCount(h.client), 0);
    assert.deepEqual(h.events, []);
  } finally {
    await h.client.close();
  }
});

test("a grant works only for its project and person, and expires", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h);
    assert.deepEqual(
      await linkProjectRepo({ projectId: P2, externalId: USER }, { grant, repoId: 501 }, h.deps()),
      { ok: false, error: "invalid_grant" },
    );
    assert.deepEqual(
      await linkProjectRepo(
        { projectId: P1, externalId: "user_mallory" },
        { grant, repoId: 501 },
        h.deps(),
      ),
      { ok: false, error: "invalid_grant" },
    );
    h.clock.now += INSTALL_GRANT_TTL_MS;
    assert.deepEqual(
      await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 501 }, h.deps()),
      { ok: false, error: "invalid_grant" },
    );
    assert.equal(await rowCount(h.client), 0);
  } finally {
    await h.client.close();
  }
});

test("a support session cannot install, link or unlink: the link outlives the session", async () => {
  const h = await setup();
  try {
    const grant = await installAndReturn(h);
    const support = h.deps({ isRestricted: async () => true });
    assert.deepEqual(await startInstall({ projectId: P1, externalId: USER }, support), {
      ok: false,
      error: "support_session",
    });
    assert.deepEqual(
      await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 501 }, support),
      { ok: false, error: "support_session" },
    );
    assert.equal(await rowCount(h.client), 0);

    assert.ok(
      (await linkProjectRepo({ projectId: P1, externalId: USER }, { grant, repoId: 501 }, h.deps()))
        .ok,
    );
    assert.deepEqual(await unlinkProjectRepo({ projectId: P1, externalId: USER }, support), {
      ok: false,
      error: "support_session",
    });
    assert.equal(await rowCount(h.client), 1);
    assert.deepEqual(
      h.events.map((e) => e.event),
      ["repo_linked"],
    );
  } finally {
    await h.client.close();
  }
});

test("with the App (client id or secret included) not configured, nothing is written", async () => {
  const h = await setup();
  try {
    const notConfigured = h.deps({ secret: null });
    assert.deepEqual(await startInstall({ projectId: P1, externalId: USER }, notConfigured), {
      ok: false,
      error: "not_configured",
    });
    assert.deepEqual(
      await completeSetup(
        { state: "a.b", cookieState: "a.b", code: OWN_CODE, installationId: "1", externalId: USER },
        notConfigured,
      ),
      { ok: false, error: "not_configured" },
    );
    assert.equal(await rowCount(h.client), 0);
  } finally {
    await h.client.close();
  }
});
