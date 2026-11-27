import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { sealSecret } from "@/lib/platform/secret-box";
import { slackCaller } from "./api";
import { channelAccess, listChannels, postToChannel, type SlackWorkspaceDeps } from "./channels";
import { disconnectSlack } from "./connection-actions";
import { isChannelError, isLostConnection, slackErrorText } from "./errors";
import { installNotice } from "./notice";
import type { SealedSlackConnection } from "./store";
import { fakeSlack } from "./test-support";

const KEY = "k".repeat(64);
const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "xoxb-s3cret";
const CONNECTION: SealedSlackConnection = {
  organizationId: ORG,
  teamId: "T1",
  teamName: "Acme",
  lost: false,
  sealedToken: sealSecret(TOKEN, `slack_connections:${ORG}`, KEY),
};
const TARGET = { organizationId: ORG, teamId: "T1", channelId: "C0000001" };
const INVITE = "This app is not in the channel: invite it with /invite.";

let slack: Awaited<ReturnType<typeof fakeSlack>>;
let lost = 0;

before(async () => {
  slack = await fakeSlack();
});
beforeEach(() => {
  slack.received = [];
  lost = 0;
});
after(() => slack.close());

test("a message is posted with the bot token", async () => {
  slack.json({ ok: true });
  assert.deepEqual(await postToChannel(TARGET, { text: "hi & *bye*" }, deps()), { ok: true });
  assert.deepEqual(slack.received, [
    {
      path: "/api/chat.postMessage",
      authorization: `Bearer ${TOKEN}`,
      params: { channel: "C0000001", text: "hi & *bye*", unfurl_links: "false" },
    },
  ]);
});

test("each error of Slack reads as what to do, and only a refused token loses the connection", async () => {
  const cases: [string, string, "channel" | "lost" | null][] = [
    ["not_in_channel", INVITE, "channel"],
    ["channel_not_found", INVITE, "channel"],
    ["is_archived", "The channel is archived.", "channel"],
    ["invalid_auth", "Slack is disconnected: connect again.", "lost"],
    ["token_revoked", "Slack is disconnected: connect again.", "lost"],
    ["account_inactive", "Slack is disconnected: connect again.", "lost"],
    ["ratelimited", "Slack gets too many requests. Try again in a minute.", null],
    ["fatal_error", "Slack answered fatal_error.", null],
  ];
  for (const [code, text, about] of cases) {
    lost = 0;
    slack.json({ ok: false, error: code });
    assert.deepEqual(await postToChannel(TARGET, { text: "hi" }, deps()), { ok: false, code });
    assert.equal(slackErrorText(code), text);
    assert.equal(isChannelError(code), about === "channel", code);
    assert.equal(isLostConnection(code), about === "lost", code);
    assert.equal(lost, about === "lost" ? 1 : 0, code);
  }
});

test("a timeout, a dead host, a redirect and an answer that is not Slack's are failures", async () => {
  const answers: [typeof slack.answer, string][] = [
    [() => {}, "timeout"],
    [(_, response) => response.destroy(), "unreachable"],
    [(_, response) => response.writeHead(302, { location: `${slack.url}/x` }).end(), "bad_answer"],
    [(_, response) => response.writeHead(500).end(`<html>${TOKEN}</html>`), "bad_answer"],
    [(_, response) => response.end(JSON.stringify({ ok: false, error: TOKEN })), "bad_answer"],
  ];
  for (const [answer, code] of answers) {
    slack.received = [];
    slack.answer = answer;
    assert.deepEqual(await postToChannel(TARGET, { text: "hi" }, deps()), { ok: false, code });
    assert.equal(slack.received.length, 1);
  }
});

test("without a workspace, with another one or with another key nobody is called", async () => {
  const post = (over: Partial<SlackWorkspaceDeps>) =>
    postToChannel(TARGET, { text: "hi" }, { ...deps(), ...over });
  assert.deepEqual(await post({ connection: async () => null }), {
    ok: false,
    code: "not_connected",
  });
  assert.deepEqual(await post({ connection: async () => ({ ...CONNECTION, teamId: "T2" }) }), {
    ok: false,
    code: "other_workspace",
  });
  assert.deepEqual(await post({ key: "z".repeat(64) }), { ok: false, code: "invalid_auth" });
  assert.deepEqual(slack.received, []);
});

test("the channel list is read page by page, and a break keeps what was read", async () => {
  const pages = (second: unknown) => {
    slack.answer = ({ params }, response) => {
      response.end(
        JSON.stringify(
          params.cursor === "next"
            ? second
            : {
                ok: true,
                channels: [
                  { id: "C0000002", name: "ops", is_private: false },
                  { id: 7, name: "odd" },
                ],
                response_metadata: { next_cursor: "next" },
              },
        ),
      );
    };
  };
  pages({ ok: true, channels: [{ id: "G0000001", name: "alerts", is_private: true }] });
  assert.deepEqual(await listChannels(ORG, deps()), {
    ok: true,
    partial: false,
    channels: [
      { id: "G0000001", name: "alerts", isPrivate: true },
      { id: "C0000002", name: "ops", isPrivate: false },
    ],
  });
  assert.equal(slack.received.length, 2);
  assert.equal(slack.received[0].params.types, "public_channel,private_channel");
  pages({ ok: false, error: "ratelimited" });
  const broken = await listChannels(ORG, deps());
  assert.ok(broken.ok && broken.partial && broken.channels.length === 1);
  slack.json({ ok: false, error: "missing_scope" });
  assert.deepEqual(await listChannels(ORG, deps()), { ok: false, code: "missing_scope" });
});

test("access: a public channel is open, a private, shared or archived one may not be", async () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{}, null],
    [{ is_private: true, is_member: true }, null],
    [{ is_ext_shared: true, is_member: true }, null],
    [{ is_private: true }, "not_in_channel"],
    [{ is_ext_shared: true }, "not_in_channel"],
    [{ is_archived: true, is_member: true }, "is_archived"],
  ];
  for (const [channel, code] of cases) {
    slack.json({ ok: true, channel: { id: "C0000001", name: "ops", ...channel } });
    const access = await channelAccess(ORG, "C0000001", deps());
    assert.deepEqual(access, {
      teamId: "T1",
      name: "ops",
      ...(code ? { ok: false, code } : { ok: true }),
    });
  }
  slack.json({ ok: false, error: "channel_not_found" });
  assert.deepEqual(await channelAccess(ORG, "C0000001", deps()), {
    ok: false,
    code: "channel_not_found",
    teamId: "T1",
  });
});

test("only an admin disconnects", async () => {
  const calls: string[] = [];
  const run = (role: "admin" | "member") =>
    disconnectSlack(PROJECT, {
      getSession: async () => ({ user: { id: "u", externalId: "ext" } }),
      findProjectScope: async (id) => ({ project: { id }, organization: { id: ORG } }),
      enabled: async () => true,
      isRestricted: async () => false,
      role: async () => role,
      revoke: async (id) => calls.push(`revoke ${id}`),
      remove: async (id) => calls.push(`remove ${id}`) > 0,
      observe: async () => {},
    });
  assert.equal((await run("member")).ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await run("admin"), { ok: true });
  assert.deepEqual(calls, [`revoke ${ORG}`, `remove ${ORG}`]);
});

test("the page tells only an outcome this module knows", () => {
  assert.deepEqual(installNotice({ slack: "connected" }), {
    ok: true,
    text: "Slack is connected.",
  });
  assert.deepEqual(installNotice({ slack: "failed", reason: "invalid_code" }), {
    ok: false,
    text: "Slack refused the install. (invalid_code)",
  });
  assert.equal(
    installNotice({ slack: "failed", reason: "<b>x" })?.text,
    "Slack refused the install.",
  );
  for (const slackValue of ["toString", "", undefined, ["failed"]])
    assert.equal(installNotice({ slack: slackValue }), null);
});

function deps(): SlackWorkspaceDeps {
  return {
    connection: async () => CONNECTION,
    markLost: async () => {
      lost += 1;
    },
    call: slackCaller(slack.url, 2_000),
    key: KEY,
  };
}
