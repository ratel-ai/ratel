import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CatalogV2HandlerDeps,
  handleCatalogV2Request,
} from "@/lib/catalog/pull-route-handler-v2";
import { etagOf, resolve, type WireSkill } from "@/lib/catalog/wire-v2";
import type { ApiKey } from "@/lib/platform/projects/schema";

const KEY = "rtl_test-key";
const HASH = "hash-of-test-key";
const PROJECT = "project-1";
const apiKeyRow = { id: "key-1", projectId: PROJECT } as ApiKey;

const wire = (over: Partial<WireSkill> & Pick<WireSkill, "name">): WireSkill => ({
  id: over.name,
  description: "",
  searchableDescription: null,
  tags: [],
  tools: [],
  metadata: {},
  body: "",
  ...over,
});

const SKILLS = [
  wire({
    name: "deploy-checklist",
    description: "Deploy safely.",
    searchableDescription: "release production rollback canary",
  }),
];
const CURRENT = etagOf(SKILLS);

function deps(over: Partial<CatalogV2HandlerDeps> = {}): CatalogV2HandlerDeps {
  return {
    isDbConfigured: () => true,
    hashApiKey: (key: string) => (key === KEY ? HASH : "wrong"),
    findActiveApiKeyByHash: async (hash: string) => (hash === HASH ? apiKeyRow : null),
    touchApiKey: async () => {},
    getProjectCatalogVersionV2: async () => CURRENT.hex,
    getPublishedCatalogV2: async () => SKILLS,
    setProjectCatalogVersionV2: async () => {},
    getScopedCatalogV2: async (_projectId, endUserId) => ({
      global: SKILLS,
      subjects: {
        [endUserId]: [
          wire({
            name: "deploy-checklist",
            description: "Deploy for this user.",
            searchableDescription: null,
          }),
        ],
      },
    }),
    ...over,
  };
}

function req(headers: Record<string, string> = {}, scope?: string): Request {
  const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return new Request(`https://cloud.ratel.sh/v2/catalog${suffix}`, {
    headers: { authorization: `Bearer ${KEY}`, ...headers },
  });
}

test("v2 returns searchableDescription under its 8-field ETag", async () => {
  const response = await handleCatalogV2Request(req(), deps());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), CURRENT.etag);
  assert.deepEqual(await response.json(), {
    catalogVersion: CURRENT.hex,
    skills: SKILLS,
  });
});

test("v2 304 fast-path does not load the catalog", async () => {
  let loaded = false;
  const response = await handleCatalogV2Request(
    req({ "if-none-match": CURRENT.etag }),
    deps({
      getPublishedCatalogV2: async () => {
        loaded = true;
        return SKILLS;
      },
    }),
  );

  assert.equal(response.status, 304);
  assert.equal(loaded, false);
});

test("v2 null stored version loads and self-heals instead of false-empty 304", async () => {
  const healed: string[] = [];
  const empty = etagOf([]);
  const response = await handleCatalogV2Request(
    req({ "if-none-match": empty.etag }),
    deps({
      getProjectCatalogVersionV2: async () => null,
      setProjectCatalogVersionV2: async (_projectId, version) => {
        healed.push(version);
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(healed, [CURRENT.hex]);
  assert.equal(response.headers.get("etag"), CURRENT.etag);
});

test("v2 scoped pulls resolve with v2 canonicalization", async () => {
  const response = await handleCatalogV2Request(req({}, "u-ada"), deps());
  const expected = resolve(
    {
      global: SKILLS,
      subjects: {
        "u-ada": [
          wire({
            name: "deploy-checklist",
            description: "Deploy for this user.",
            searchableDescription: null,
          }),
        ],
      },
    },
    "u-ada",
  );
  const expectedTag = etagOf(expected);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), expectedTag.etag);
  assert.deepEqual(await response.json(), {
    catalogVersion: expectedTag.hex,
    skills: expected,
  });
});
