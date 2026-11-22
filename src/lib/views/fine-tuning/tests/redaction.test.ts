import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import {
  addCounts,
  type CallContent,
  emptyCounts,
  REDACTION_VERSION,
  redactCall,
  redactionRulesFingerprint,
  redactText,
} from "../domain/redaction";

/**
 * RC-1126: pattern redaction of one model call. Every expected value here is
 * written by hand. Secret fixtures are built from parts so that no real-looking
 * key sits in the source as one literal.
 */

const FAKE = {
  anthropicKey: "sk-" + "ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
  openaiKey: "sk-" + "proj-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2",
  stripeKey: "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  githubToken: "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  awsKeyId: "AKIA" + "IOSFODNN7EXAMPLE",
  slackToken: "xox" + "b-" + "1234567890-abcdefghij",
  googleKey: "AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
  jwt:
    "eyJ" +
    "hbGciOiJIUzI1NiJ9" +
    ".eyJ" +
    "zdWIiOiIxMjM0NTY3ODkwIn0" +
    ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  bearer: "Bearer " + "abc123DEF456ghi789JKL",
  privateKey:
    "-----BEGIN " +
    "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END " +
    "RSA PRIVATE KEY-----",
};

const redacted = (input: string) => redactText(input).text;
const counted = (input: string) => redactText(input).counts;

test("email: addresses become [EMAIL_n]", () => {
  assert.equal(redacted("write to mario.rossi+test@example.co.uk now"), "write to [EMAIL_1] now");
  assert.equal(redacted("a@b.io and c_d@sub.example.com"), "[EMAIL_1] and [EMAIL_2]");
});

test("email near misses stay: a handle, a decorator, a version tag", () => {
  for (const text of [
    "ping @mario on slack",
    "@Component({ selector: 'app' })",
    "npm i react@19.2.0",
    "user@localhost",
  ]) {
    assert.equal(redacted(text), text);
  }
});

test("phone: international and local numbers with separators become [PHONE_n]", () => {
  assert.equal(redacted("call +39 333 123 4567 today"), "call [PHONE_1] today");
  assert.equal(redacted("US office: +1 (415) 555-0132."), "US office: [PHONE_1].");
  assert.equal(redacted("(415) 555-0132"), "[PHONE_1]");
  assert.equal(redacted("+393331234567"), "[PHONE_1]");
  assert.equal(redacted("tel 02 1234 5678"), "tel [PHONE_1]");
});

test("phone near misses stay: version strings, dates, short numbers, bare digit runs", () => {
  for (const text of [
    "Windows 10.0.19045.3803",
    "release v2.31.4-rc.1",
    "at 2026-11-20 19:50",
    "build 1.2.3 4.5.6",
    "room 12 34",
    "unix ts 1763668200",
    "ref 192.168.100.200",
  ]) {
    assert.equal(redacted(text), text);
  }
});

test("payment card: Luhn-valid numbers become [CARD_n], with or without separators", () => {
  assert.equal(redacted("card 4111 1111 1111 1111 exp 12/29"), "card [CARD_1] exp 12/29");
  assert.equal(redacted("5555-5555-5555-4444"), "[CARD_1]");
  assert.equal(redacted("amex 378282246310005"), "amex [CARD_1]");
});

test("payment card near misses stay: a 16-digit order number that fails Luhn", () => {
  assert.equal(redacted("order 1234567812345678 shipped"), "order 1234567812345678 shipped");
  assert.equal(redacted("order 1234-5678-1234-5678"), "order 1234-5678-1234-5678");
  assert.equal(redacted("4111 1111 1111 1112"), "4111 1111 1111 1112");
});

test("IBAN: mod-97-valid IBANs become [IBAN_n], compact or grouped", () => {
  assert.equal(redacted("pay to IT60X0542811101000000123456."), "pay to [IBAN_1].");
  assert.equal(redacted("GB82 WEST 1234 5698 7654 32"), "[IBAN_1]");
  assert.equal(redacted("DE89370400440532013000"), "[IBAN_1]");
});

test("IBAN near misses stay: a bad check digit, an id that only looks like one", () => {
  assert.equal(redacted("IT60X0542811101000000123457"), "IT60X0542811101000000123457");
  assert.equal(redacted("SKU AB12CDEF3456GHIJ"), "SKU AB12CDEF3456GHIJ");
});

test("national id: a valid codice fiscale and a US SSN become [NATIONAL_ID_n]", () => {
  assert.equal(redacted("CF: RSSMRA85T10A562S"), "CF: [NATIONAL_ID_1]");
  assert.equal(redacted("cf rssmra85t10a562s"), "cf [NATIONAL_ID_1]");
  assert.equal(redacted("SSN 123-45-6789"), "SSN [NATIONAL_ID_1]");
});

test("national id near misses stay: a bad check letter, impossible SSNs", () => {
  assert.equal(redacted("RSSMRA85T10A562T"), "RSSMRA85T10A562T");
  assert.equal(redacted("000-12-3456"), "000-12-3456");
  assert.equal(redacted("666-12-3456"), "666-12-3456");
  assert.equal(redacted("123-00-4567"), "123-00-4567");
});

test("secrets: API key shapes, bearer tokens, JWTs and private key blocks become [SECRET_n]", () => {
  assert.equal(redacted(`key=${FAKE.anthropicKey}`), "key=[SECRET_1]");
  assert.equal(redacted(FAKE.openaiKey), "[SECRET_1]");
  assert.equal(redacted(FAKE.stripeKey), "[SECRET_1]");
  assert.equal(redacted(`token ${FAKE.githubToken}`), "token [SECRET_1]");
  assert.equal(redacted(`AWS_ACCESS_KEY_ID=${FAKE.awsKeyId}`), "AWS_ACCESS_KEY_ID=[SECRET_1]");
  assert.equal(redacted(FAKE.slackToken), "[SECRET_1]");
  assert.equal(redacted(FAKE.googleKey), "[SECRET_1]");
  assert.equal(redacted(`jwt ${FAKE.jwt}`), "jwt [SECRET_1]");
  assert.equal(redacted(`Authorization: ${FAKE.bearer}`), "Authorization: Bearer [SECRET_1]");
  assert.equal(redacted(`here:\n${FAKE.privateKey}\nend`), "here:\n[SECRET_1]\nend");
});

test("secret near misses stay: prose words, a short bearer, a public key block", () => {
  for (const text of [
    "the task-runner skipped",
    "Bearer abc",
    "ask-me-anything",
    "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n-----END PUBLIC KEY-----",
  ]) {
    assert.equal(redacted(text), text);
  }
});

test("the same value in one call gets the same index; a new value gets the next one", () => {
  const out = redactText(
    "mail a@x.io, then b@x.io, then A@X.IO again; card 4111111111111111 = 4111 1111 1111 1111",
  );
  assert.equal(
    out.text,
    "mail [EMAIL_1], then [EMAIL_2], then [EMAIL_1] again; card [CARD_1] = [CARD_1]",
  );
  assert.deepEqual(out.counts, {
    secret: 0,
    email: 3,
    iban: 0,
    payment_card: 2,
    national_id: 0,
    phone: 0,
  });
});

test("counts name each kind once per occurrence", () => {
  assert.deepEqual(
    counted(
      `x@y.io +39 333 123 4567 ${FAKE.awsKeyId} RSSMRA85T10A562S DE89370400440532013000 4111111111111111`,
    ),
    {
      secret: 1,
      email: 1,
      iban: 1,
      payment_card: 1,
      national_id: 1,
      phone: 1,
    },
  );
  assert.deepEqual(counted("nothing to see"), emptyCounts());
});

const CALL: CallContent = {
  system: "You are the support agent of ops@acme.io.",
  tools: [
    {
      name: "lookup_customer",
      description: "Find a customer. Example: lookup_customer({ email: 'demo@acme.io' })",
      parameters: {
        type: "object",
        properties: { email: { type: "string", examples: ["ops@acme.io"] } },
      },
    },
  ],
  messages: [
    { role: "user", content: "I am anna@example.com, my phone is +39 333 123 4567." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking up anna@example.com." },
        {
          type: "tool_call",
          id: "call_1",
          name: "lookup_customer",
          arguments: {
            email: "anna@example.com",
            note: { iban: "DE89370400440532013000" },
            limit: 3,
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"card":"4111 1111 1111 1111","ssn":"123-45-6789"}',
    },
  ] satisfies CloudMessage[],
  output: [
    {
      role: "assistant",
      content: [{ type: "text", text: `Done. Your key ${FAKE.stripeKey} was rotated.` }],
    },
  ],
};

test("redaction covers system, tool definitions, message text, tool call arguments, tool results and the output", () => {
  const { content, counts } = redactCall(CALL);
  assert.deepEqual(content, {
    system: "You are the support agent of [EMAIL_1].",
    tools: [
      {
        name: "lookup_customer",
        description: "Find a customer. Example: lookup_customer({ email: '[EMAIL_2]' })",
        parameters: {
          type: "object",
          properties: { email: { type: "string", examples: ["[EMAIL_1]"] } },
        },
      },
    ],
    messages: [
      { role: "user", content: "I am [EMAIL_3], my phone is [PHONE_1]." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking up [EMAIL_3]." },
          {
            type: "tool_call",
            id: "call_1",
            name: "lookup_customer",
            arguments: { email: "[EMAIL_3]", note: { iban: "[IBAN_1]" }, limit: 3 },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"card":"[CARD_1]","ssn":"[NATIONAL_ID_1]"}',
      },
    ],
    output: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done. Your key [SECRET_1] was rotated." }],
      },
    ],
  });
  assert.deepEqual(counts, {
    secret: 1,
    email: 6,
    iban: 1,
    payment_card: 1,
    national_id: 1,
    phone: 1,
  });
});

test("redactCall keeps the other fields of the call and leaves the input untouched", () => {
  const call = {
    ...CALL,
    provider: "anthropic",
    model: "claude-haiku-5-5",
    ts: "2026-11-20T10:00:00Z",
  };
  const before = structuredClone(call);
  const { content } = redactCall(call);
  assert.equal(content.model, "claude-haiku-5-5");
  assert.equal(content.provider, "anthropic");
  assert.deepEqual(call, before);
});

test("redaction is pure: the same input gives the same output and counts", () => {
  const first = redactCall(CALL);
  const second = redactCall(structuredClone(CALL));
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("addCounts sums per kind", () => {
  const a = { secret: 1, email: 2, iban: 0, payment_card: 0, national_id: 0, phone: 3 };
  const b = { secret: 0, email: 1, iban: 1, payment_card: 0, national_id: 2, phone: 0 };
  assert.deepEqual(addCounts(a, b), {
    secret: 1,
    email: 3,
    iban: 1,
    payment_card: 0,
    national_id: 2,
    phone: 3,
  });
});

/**
 * The pinned pair. When this fails, you changed REDACTION_RULES: raise
 * REDACTION_VERSION and pin the new fingerprint next to it. Never update the
 * fingerprint alone: datasets record the version they were redacted with.
 */
const PINNED = { version: 1, fingerprint: "54463b3949053cc1" };

test("REDACTION_VERSION changes with the rule list", () => {
  assert.deepEqual(
    { version: REDACTION_VERSION, fingerprint: redactionRulesFingerprint() },
    PINNED,
    "The redaction rules changed: raise REDACTION_VERSION and pin the new fingerprint.",
  );
});
