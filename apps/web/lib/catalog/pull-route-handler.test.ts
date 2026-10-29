import assert from "node:assert/strict";
import { test } from "node:test";
import { type CatalogHandlerDeps, handleCatalogRequest } from "@/lib/catalog/pull-route-handler";
import { etagOf, resolve, type WireSkill } from "@/lib/catalog/wire";
import type { ApiKey } from "@/lib/platform/projects/schema";

const KEY = "rtl_test-key";
const HASH = "hash-of-test-key";
const PROJECT = "project-1";

const apiKeyRow = { id: "key-1", projectId: PROJECT } as ApiKey;

const wire = (over: Partial<WireSkill> & Pick<WireSkill, "name">): WireSkill => ({
  id: over.name,
  description: "",
  tags: [],
  tools: [],
  metadata: {},
  body: "",
  ...over,
});

const SKILLS: WireSkill[] = [
  wire({ name: "b-skill", description: "second", tags: ["x"], body: "B body" }),
  wire({ name: "a-skill", description: "first", body: "A body" }),
];

/** The authoritative tag of the fixture set — what a consistent store holds. */
const CURRENT = etagOf([...SKILLS].sort((a, b) => (a.id < b.id ? -1 : 1)));

/** One end-user's own published skills: an `a-skill` that SHADOWS the global one by
 * name, plus a subject-only `z-skill`. */
const SUBJECT_SKILLS: Record<string, WireSkill[]> = {
  "u-alice": [
    wire({ name: "a-skill", description: "alice override", body: "Alice A" }),
    wire({ name: "z-skill", description: "alice only" }),
  ],
};

/** Fully-stubbed happy-path deps (stored hash consistent); override per test. */
function deps(over: Partial<CatalogHandlerDeps> = {}): CatalogHandlerDeps {
  return {
    isDbConfigured: () => true,
    hashApiKey: (k: string) => (k === KEY ? HASH : "wrong"),
    findActiveApiKeyByHash: async (h: string) => (h === HASH ? apiKeyRow : null),
    touchApiKey: async () => {},
    getProjectCatalogVersion: async (p: string) => (p === PROJECT ? CURRENT.hex : null),
    getPublishedCatalog: async (p: string) => (p === PROJECT ? SKILLS : []),
    setProjectCatalogVersion: async () => {},
    getScopedCatalog: async (p: string, endUserId: string) => ({
      global: p === PROJECT ? SKILLS : [],
      subjects: { [endUserId]: (p === PROJECT && SUBJECT_SKILLS[endUserId]) || [] },
    }),
    ...over,
  };
}

function req(
  headers: Record<string, string> = {},
  url = "https://cloud.ratel.sh/v1/catalog",
): Request {
  return new Request(url, { method: "GET", headers });
}

const auth = { authorization: `Bearer ${KEY}` };

test("stamps the project onto the request log context", async () => {
  const contexts: unknown[][] = [];
  const res = await handleCatalogRequest(
    req(auth),
    deps({ setRequestLogContext: (...args) => contexts.push(args) }),
  );

  assert.equal(res.status, 200);
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0]?.[1], { project_id: "project-1" });
});

test("401 when the Authorization header is missing", async () => {
  const res = await handleCatalogRequest(req(), deps());
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    error: { code: "unauthorized", message: "Missing or malformed Authorization: Bearer <key>." },
  });
});

test("401 when the key is unknown or revoked", async () => {
  const res = await handleCatalogRequest(
    req({ authorization: "Bearer nope" }),
    deps({ findActiveApiKeyByHash: async () => null }),
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthorized");
});

test("503 when the database is not configured", async () => {
  const res = await handleCatalogRequest(req(auth), deps({ isDbConfigured: () => false }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "unavailable");
});

test("200 returns the catalog sorted by id with an ETag header", async () => {
  const res = await handleCatalogRequest(req(auth), deps());
  assert.equal(res.status, 200);
  const etag = res.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]{64}"$/, "strong hex ETag");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const body = await res.json();
  assert.equal(body.catalogVersion, etag?.replace(/"/g, ""), "catalogVersion is the bare hex");
  assert.deepEqual(
    body.skills.map((s: { id: string }) => s.id),
    ["a-skill", "b-skill"],
    "sorted by id",
  );
  assert.deepEqual(body.skills[0], {
    id: "a-skill",
    name: "a-skill",
    description: "first",
    tags: [],
    tools: [],
    metadata: {},
    body: "A body",
  });
});

test("304 fast-path answers from the stored hash without loading the catalog", async () => {
  let loaded = false;
  const res = await handleCatalogRequest(
    req({ ...auth, "if-none-match": `"${CURRENT.hex}"` }),
    deps({
      getPublishedCatalog: async () => {
        loaded = true;
        return SKILLS;
      },
    }),
  );
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("etag"), CURRENT.etag);
  assert.equal(await res.text(), "", "304 has no body");
  assert.equal(loaded, false, "the catalog is never loaded on the fast path");
});

test("304 fast-path serves the empty-set tag before the first publish (null stored)", async () => {
  const empty = etagOf([]);
  const res = await handleCatalogRequest(
    req({ ...auth, "if-none-match": empty.etag }),
    deps({ getProjectCatalogVersion: async () => null, getPublishedCatalog: async () => [] }),
  );
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("etag"), empty.etag);
});

test("200 self-heals a stale stored hash", async () => {
  const healed: string[] = [];
  const res = await handleCatalogRequest(
    req(auth),
    deps({
      getProjectCatalogVersion: async () => "stale-stored-value",
      setProjectCatalogVersion: async (_p, v) => {
        healed.push(v);
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(healed, [CURRENT.hex], "stored value converges to the authoritative hash");
});

test("200 does NOT rewrite the stored hash when it already matches", async () => {
  const healed: string[] = [];
  const res = await handleCatalogRequest(
    req(auth),
    deps({
      setProjectCatalogVersion: async (_p, v) => {
        healed.push(v);
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(healed, [], "no redundant write when stored is current");
});

test("stale stored hash + If-None-Match matching the FRESH set still 304s (post-heal)", async () => {
  // The client's cache is actually current; only the stored column lagged. After
  // the full read heals the store, the conditional check against the authoritative
  // tag must still convert to a bodyless 304.
  const res = await handleCatalogRequest(
    req({ ...auth, "if-none-match": CURRENT.etag }),
    deps({ getProjectCatalogVersion: async () => "stale-stored-value" }),
  );
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("etag"), CURRENT.etag);
});

test("200 again when If-None-Match is a miss", async () => {
  const res = await handleCatalogRequest(req({ ...auth, "if-none-match": '"deadbeef"' }), deps());
  assert.equal(res.status, 200);
});

test("empty project yields the frozen empty-set ETag", async () => {
  const res = await handleCatalogRequest(
    req(auth),
    deps({
      getProjectCatalogVersion: async () => null,
      getPublishedCatalog: async () => [],
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("etag"),
    '"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"',
  );
  assert.deepEqual((await res.json()).skills, []);
});

test("?scope serves global + the subject layer, subject shadowing global by name", async () => {
  const reads = { got: false, set: false };
  const res = await handleCatalogRequest(
    req(auth, "https://cloud.ratel.sh/v1/catalog?scope=u-alice"),
    deps({
      getProjectCatalogVersion: async () => {
        reads.got = true;
        return CURRENT.hex;
      },
      setProjectCatalogVersion: async () => {
        reads.set = true;
      },
    }),
  );
  assert.equal(res.status, 200);

  const expected = resolve(
    { global: SKILLS, subjects: { "u-alice": SUBJECT_SKILLS["u-alice"] } },
    "u-alice",
  );
  const { hex, etag } = etagOf(expected);
  const body = (await res.json()) as { catalogVersion: string; skills: WireSkill[] };
  assert.equal(body.catalogVersion, hex);
  assert.deepEqual(body.skills, expected);
  assert.equal(res.headers.get("etag"), etag);

  // a-skill is the alice override, not the global "first"; z-skill is subject-only.
  assert.equal(body.skills.find((s) => s.name === "a-skill")?.description, "alice override");
  assert.ok(body.skills.some((s) => s.name === "z-skill"));

  // The stored GLOBAL version is neither read nor healed for a scoped pull.
  assert.equal(reads.got, false, "scoped pull must not read the stored global version");
  assert.equal(reads.set, false, "scoped pull must not heal/clobber the stored global version");
});

test("?scope returns 304 when If-None-Match matches the scoped ETag", async () => {
  const { etag } = etagOf(
    resolve({ global: SKILLS, subjects: { "u-alice": SUBJECT_SKILLS["u-alice"] } }, "u-alice"),
  );
  const res = await handleCatalogRequest(
    req({ ...auth, "if-none-match": etag }, "https://cloud.ratel.sh/v1/catalog?scope=u-alice"),
    deps(),
  );
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("etag"), etag);
});

test("?scope naming an unknown subject is byte-identical to no scope", async () => {
  const noScope = await handleCatalogRequest(req(auth), deps());
  const unknown = await handleCatalogRequest(
    req(auth, "https://cloud.ratel.sh/v1/catalog?scope=nobody"),
    deps(),
  );
  assert.equal(unknown.headers.get("etag"), noScope.headers.get("etag"));
});
