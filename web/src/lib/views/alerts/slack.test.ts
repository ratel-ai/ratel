import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { sealSecret } from "@/lib/platform/secret-box";
import { changeDestination, type DestinationActionDeps } from "./destination-actions";
import type { AlertNotice } from "./notifier";
import { slackNotifier } from "./slack";
import { parseSlackWebhook } from "./slack-url";
import { type PostWebhook, postWebhook } from "./webhook-post";

const KEY = "k".repeat(64);
const URL_TEXT = "https://hooks.slack.com/services/T0/B0/s3cretABCD";
const ID = "55555555-5555-4555-8555-555555555555";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOTICE: AlertNotice = {
  eventId: "e",
  kind: "fire",
  ruleId: "rule-1",
  ruleName: "Errors <!channel> & more",
  projectId: PROJECT,
  projectName: "Agent",
  query: { metric: "error_rate", aggregation: "rate", filter: {} },
  operator: "above",
  threshold: 0.5,
  windowMinutes: 5,
  value: 0.667,
  at: new Date("2026-11-24T10:00:00Z"),
  sentTo: [],
};

type Answer = (request: IncomingMessage, response: ServerResponse) => void;
const ok: Answer = (_, response) => response.end("ok");
let answer: Answer = ok;
let received: { method?: string; path?: string; type?: string; body: string }[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    received.push({
      method: request.method,
      path: request.url,
      type: request.headers["content-type"],
      body,
    });
    answer(request, response);
  });
});
let base: string;

/** The real post, to the local server in Slack's place. */
const toFake: PostWebhook = (url, body) => {
  assert.equal(url.origin, "https://hooks.slack.com");
  return postWebhook(new URL(url.pathname, base), body, 150);
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  answer = ok;
  received = [];
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("a fire and a recovery post the rule, the numbers and the link", async () => {
  const notifier = slack();
  assert.deepEqual(await notifier.send(NOTICE), { sentTo: [ID], error: null });
  await notifier.send({ ...NOTICE, kind: "recovery", value: 0.1 });
  assert.deepEqual(
    received.map(({ method, path, type }) => [method, path, type]),
    Array(2).fill(["POST", "/services/T0/B0/s3cretABCD", "application/json"]),
  );
  const [fire, recovery] = received.map(({ body }) => JSON.parse(body).text as string);
  assert.equal(
    fire,
    ":rotating_light: Alert: *Errors &lt;!channel&gt; &amp; more* (Agent)\n" +
      "Value 66.7%. Alert when Error rate is above 50% over 5 minutes.\n" +
      `<https://ratel.test/project/${PROJECT}/alerts/rule-1|Open the alert>`,
  );
  assert.match(recovery, /^:white_check_mark: Recovered: .*\nValue 10%\./);
});

test("a non-2xx answer, a redirect, a timeout and a dead host are failures", async () => {
  const cases: [Answer, RegExp][] = [
    [respond(404, "no_service"), /^Ops: Slack answered 404 \(no_service\)\.$/],
    [respond(500, `<html>${URL_TEXT}</html>`), /^Ops: Slack answered 500\.$/],
    [
      (_, response) => response.writeHead(302, { location: `${base}/elsewhere` }).end(),
      /^Ops: Slack answered 302\.$/,
    ],
    [() => {}, /^Ops: Slack did not answer in 0\.15 seconds\.$/],
    [(request) => request.socket.destroy(), /^Ops: Slack could not be reached\.$/],
  ];
  for (const [next, error] of cases) {
    answer = next;
    received = [];
    const outcome = await slack().send(NOTICE);
    assert.deepEqual(outcome.sentTo, []);
    assert.match(outcome.error ?? "", error);
    assert.equal(received.length, 1);
  }
});

test("a retry goes only where the message did not arrive", async () => {
  assert.deepEqual(await slack().send({ ...NOTICE, sentTo: [ID] }), { sentTo: [ID], error: null });
  assert.deepEqual(received, []);
});

test("the stored address is opened and checked again before a send", async () => {
  const moved = slack({ sealedUrl: sealSecret(URL_TEXT, "alert_destinations:other", KEY) });
  assert.match((await moved.send(NOTICE)).error ?? "", /cannot be opened/);
  const elsewhere = slack({
    sealedUrl: sealSecret("https://evil.test/x", `alert_destinations:${ID}`, KEY),
  });
  assert.match((await elsewhere.send(NOTICE)).error ?? "", /not a Slack address/);
  assert.deepEqual(received, []);
});

test("only https://hooks.slack.com/ is an address", () => {
  assert.equal(parseSlackWebhook(` ${URL_TEXT} `)?.href, URL_TEXT);
  for (const refused of [
    "http://hooks.slack.com/services/T/B/x",
    "https://hooks.slack.com.evil.test/services/x",
    "https://evil.test/hooks.slack.com/services/x",
    "https://user:pass@hooks.slack.com/services/x",
    "https://user@hooks.slack.com/services/x",
    "https://hooks.slack.com@evil.test/services/x",
    "https://hooks.slack.com:8443/services/x",
    "https://hooks.slack.com./services/x",
    "https://hooks.slack.com/",
    "https://hooks.slack.com/services/x?u=1",
    "javascript:alert(1)",
    "",
    null,
  ])
    assert.equal(parseSlackWebhook(refused), null, String(refused));
});

test("add, test and remove never repeat the URL, whoever asks", async () => {
  const seen: unknown[] = [];
  const created: { name: string; url: URL }[] = [];
  const deps = actionDeps(seen, (input) => created.push(input));
  const added = await changeDestination(
    { projectId: PROJECT, action: "add", name: " Ops ", url: URL_TEXT },
    deps,
  );
  assert.deepEqual(added, { ok: true, destinationId: ID });
  assert.deepEqual([created[0].name, created[0].url.href], ["Ops", URL_TEXT]);
  const run = (input: Record<string, unknown>, over: Partial<DestinationActionDeps> = {}) =>
    changeDestination({ projectId: PROJECT, ...input }, { ...deps, ...over });
  const results = [
    added,
    await run({ action: "add", name: "Ops", url: "http://hooks.slack.com/services/s3cretABCD" }),
    await run({ action: "add", name: "Ops", url: "https://u:p@hooks.slack.com/s3cretABCD" }),
    await run({ action: "add", name: "Ops", url: URL_TEXT }, { canSeal: () => false }),
    await run({ action: "add", name: "Ops", url: URL_TEXT }, { enabled: async () => false }),
    await run({ action: "add", name: "Ops", url: URL_TEXT }, { isRestricted: async () => true }),
    await run(
      { action: "add", name: "Ops", url: URL_TEXT },
      { findProjectScope: async () => null },
    ),
    await run(
      { action: "test", destinationId: ID },
      { post: async () => ({ ok: false, error: "Slack answered 404." }) },
    ),
    await run({ action: "test", destinationId: ID }, { sealed: async () => null }),
    await run({ action: "remove", destinationId: "x" }),
  ];
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, ...Array(9).fill(false)],
  );
  assert.equal(created.length, 1);
  assert.deepEqual(results[7], { ok: false, error: "Slack answered 404." });
  assert.ok((await run({ action: "test", destinationId: ID })).ok);
  assert.ok((await run({ action: "remove", destinationId: ID })).ok);
  assert.doesNotMatch(JSON.stringify([results, seen]), /s3cret|\/services/);
});

function slack(over: { sealedUrl?: string } = {}) {
  return slackNotifier({
    destinationsOf: async () => [sealedRow(over.sealedUrl)],
    post: toFake,
    baseUrl: "https://ratel.test",
    key: KEY,
  });
}

function sealedRow(sealedUrl = sealSecret(URL_TEXT, `alert_destinations:${ID}`, KEY)) {
  return { id: ID, name: "Ops", lastFour: "ABCD", sealedUrl };
}

function respond(status: number, body: string): Answer {
  return (_, response) => response.writeHead(status).end(body);
}

function actionDeps(
  seen: unknown[],
  onCreate: (input: { name: string; url: URL }) => void,
): DestinationActionDeps {
  return {
    getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
    findProjectScope: async (id) => ({ project: { id }, organization: { id: "org" } }),
    enabled: async () => true,
    isRestricted: async () => false,
    canSeal: () => true,
    count: async () => 0,
    create: async (input) => {
      onCreate(input);
      return ID;
    },
    remove: async () => true,
    sealed: async () => sealedRow(),
    post: async () => ({ ok: true }),
    projectName: async () => "Agent",
    observe: async (fields) => {
      seen.push(fields);
    },
  };
}
