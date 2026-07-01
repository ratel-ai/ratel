#!/usr/bin/env node
// End-to-end check for the Ratel Cloud telemetry clients.
//
// Drives the full wire path — validate → batch → POST with `Authorization: Bearer` —
// through BOTH shipped clients (the built @ratel-ai/cloud TS package and the
// ratel_ai_cloud Python package) against a real ingest endpoint.
//
//   Endpoint : $RATEL_CLOUD_ENDPOINT   (default http://localhost:3000/api/v1/events)
//   API key  : $RATEL_CLOUD_API_KEY    (required for --live; a test key is used in mock mode)
//
// Modes:
//   (default)  hit the endpoint; if nothing is listening, fall back to the built-in
//              mock ingest server so you still get a full run.
//   --live     hit the endpoint and FAIL if it is unreachable (no fallback).
//   --mock     always use the built-in mock ingest server (offline / CI).
//
// The mock server additionally asserts what actually arrives on the wire: the Bearer
// key, `content-type`, batch splitting, per-event schema conformance (re-validated with
// the client's own validator), and the 401 rejection path.

import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = resolve(HERE, "..");
const FIXTURES = join(CLOUD_DIR, "fixtures");
const TS_DIST_INDEX = join(CLOUD_DIR, "ts", "dist", "index.js");
const PY_VENV = join(CLOUD_DIR, "python", ".venv", "bin", "python");
const PY_RUNNER = join(HERE, "_py_runner.py");

const args = new Set(process.argv.slice(2));
const FORCE_MOCK = args.has("--mock");
const FORCE_LIVE = args.has("--live");

const ENDPOINT = process.env.RATEL_CLOUD_ENDPOINT ?? "http://localhost:3000/api/v1/events";
const MOCK_KEY = "rtl_e2e_localtest";
const API_KEY = process.env.RATEL_CLOUD_API_KEY ?? (FORCE_LIVE ? undefined : MOCK_KEY);

// ── tiny assertion harness ──────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ── fixtures: the shared cross-language contract ─────────────────────────────
function loadFixtures(kind) {
  const dir = join(FIXTURES, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
const VALID = loadFixtures("valid");
const INVALID = loadFixtures("invalid");

// A valid event guaranteed unique per call. A real ingest endpoint deduplicates
// (accepted = count of *newly* ingested events), so the static fixtures report
// `accepted: 0` after their first-ever run. A fresh nonce in the body proves the
// endpoint genuinely ingests — accepted: 1 — every run.
function uniqueEvent(tag) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    provider: "openai",
    model: "gpt-5.5",
    ts: new Date().toISOString(),
    stream: false,
    messages: [{ role: "user", content: `ratel-e2e ${tag} ${nonce}` }],
  };
}

// ── reachability probe ───────────────────────────────────────────────────────
function reachable(host, port, timeoutMs = 600) {
  return new Promise((res) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

// ── built-in mock ingest server (mock mode) ──────────────────────────────────
// Buckets received events by the `?client=` query param so each phase can be
// asserted independently. Re-validates every event with the client's own
// validator: a client must never put a schema-invalid event on the wire.
function startMockServer(validate) {
  const buckets = new Map(); // client -> { requests: [{count, auth, ctype, badWire}], events: [] }
  const bucket = (c) => {
    if (!buckets.has(c)) buckets.set(c, { requests: [], events: [] });
    return buckets.get(c);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    const client = url.searchParams.get("client") ?? "default";
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const auth = req.headers["authorization"];
      const key = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (key !== MOCK_KEY) {
        bucket(client).requests.push({ count: 0, auth, rejected: true });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let events = [];
      try {
        events = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const badWire = events.filter((e) => !validate(e).ok).length;
      const b = bucket(client);
      b.requests.push({
        count: events.length,
        auth,
        ctype: req.headers["content-type"],
        badWire,
      });
      b.events.push(...events);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: events.length }));
    });
  });

  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      res({ server, buckets, base: `http://127.0.0.1:${port}/api/v1/events` });
    });
  });
}

// ── endpoint builder: adds ?client= only against the mock ────────────────────
function makeEndpoint(base, client, isMock) {
  if (!isMock) return base;
  const u = new URL(base);
  u.searchParams.set("client", client);
  return u.toString();
}

// ── TS phase ─────────────────────────────────────────────────────────────────
async function runTs({ base, isMock, RatelCloud, sendBatch }) {
  section("TypeScript client (@ratel-ai/cloud)");

  // (a) client behaviour: valid enqueued, invalid dropped, small batch → split.
  const drops = [];
  const cloud = new RatelCloud({
    endpoint: makeEndpoint(base, "ts-client", isMock),
    apiKey: API_KEY,
    batchSize: 2,
    flushIntervalMs: 0,
    onError: (e) => drops.push(String(e?.message ?? e)),
  });
  for (const ev of VALID) cloud.record(ev);
  for (const ev of INVALID) cloud.record(ev);
  await cloud.close();

  const validationDrops = drops.filter((m) => m.includes("dropped invalid event")).length;
  check(`records ${VALID.length} valid, drops ${INVALID.length} invalid`, validationDrops === INVALID.length, `dropped ${validationDrops}`);

  // (b) wire acceptance via the raw transport (works live and in mock).
  // Default retries (3) so a cold backend route (e.g. a Next.js dev server
  // compiling the handler on first hit → transient 5xx) is absorbed, not failed.
  const result = await sendBatch(VALID, {
    endpoint: makeEndpoint(base, "ts-batch", isMock),
    apiKey: API_KEY,
  });
  check("sendBatch fixtures accepted (2xx)", result.ok, `status=${result.status}`);

  // (c) genuine ingestion: a fresh, never-sent event must be newly ingested.
  const probe = await sendBatch([uniqueEvent("ts")], {
    endpoint: makeEndpoint(base, "ts-probe", isMock),
    apiKey: API_KEY,
  });
  check("fresh event ingested (accepted=1)", probe.ok && probe.accepted === 1, `ok=${probe.ok} accepted=${probe.accepted}`);

  return { drops };
}

// ── Python phase (spawns the venv interpreter) ───────────────────────────────
function runPython({ base, isMock }) {
  section("Python client (ratel_ai_cloud)");
  if (!existsSync(PY_VENV)) {
    check("python venv present", false, `missing ${PY_VENV} — run the python dev setup (see python/README.md)`);
    return Promise.resolve(null);
  }
  const clientEndpoint = makeEndpoint(base, "py-client", isMock);
  const batchEndpoint = makeEndpoint(base, "py-batch", isMock);
  return new Promise((res) => {
    const proc = spawn(PY_VENV, [PY_RUNNER, clientEndpoint, batchEndpoint, API_KEY, FIXTURES], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("close", (code) => {
      if (code !== 0) {
        check("python runner exited cleanly", false, `exit code ${code}`);
        return res(null);
      }
      let summary;
      try {
        summary = JSON.parse(out.trim().split("\n").pop());
      } catch {
        check("python runner emitted JSON summary", false, out.slice(0, 200));
        return res(null);
      }
      check(`records ${VALID.length} valid, drops ${INVALID.length} invalid`, summary.drops === INVALID.length, `dropped ${summary.drops}`);
      check("send_batch fixtures accepted (2xx)", summary.batch_ok === true, `status=${summary.batch_status}`);
      check("fresh event ingested (accepted=1)", summary.probe_ok === true && summary.probe_accepted === 1, `ok=${summary.probe_ok} accepted=${summary.probe_accepted}`);
      res(summary);
    });
  });
}

// ── mock-only wire assertions ─────────────────────────────────────────────────
async function assertMockWire({ buckets, RatelCloud, sendBatch, base }) {
  section("Wire inspection (mock only)");

  const cli = buckets.get("ts-client");
  check("TS client delivered all valid events", cli && cli.events.length === VALID.length, `got ${cli?.events.length}`);
  check("TS client split into batches (batchSize=2)", cli && cli.requests.length === Math.ceil(VALID.length / 2), `requests=${cli?.requests.length}`);
  check("every wire event is schema-valid", cli && cli.requests.every((r) => r.badWire === 0));
  check("Authorization: Bearer <key> present", cli && cli.requests.every((r) => r.auth === `Bearer ${MOCK_KEY}`));
  check("content-type is application/json", cli && cli.requests.every((r) => (r.ctype ?? "").includes("application/json")));

  const py = buckets.get("py-client");
  if (py) check("Python client delivered all valid events", py.events.length === VALID.length, `got ${py.events.length}`);

  // 401 rejection path: a wrong key is dropped best-effort (no throw, onError fires).
  const rejErrors = [];
  const bad = await sendBatch(VALID, {
    endpoint: makeEndpoint(base, "badkey", true),
    apiKey: "rtl_wrong_key",
    maxRetries: 0,
    onError: (e) => rejErrors.push(String(e)),
  });
  check("wrong key → rejected best-effort (result.ok false, status 401)", bad.ok === false && bad.status === 401, `ok=${bad.ok} status=${bad.status}`);
  check("rejection surfaced via onError, never thrown", rejErrors.length >= 1);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(TS_DIST_INDEX)) {
    console.error(`TS client is not built (${TS_DIST_INDEX} missing). Run: pnpm --dir ${join(CLOUD_DIR, "ts")} build`);
    process.exit(2);
  }
  const ts = await import(pathToFileURL(TS_DIST_INDEX).href);
  const { RatelCloud, sendBatch, validate } = ts;

  console.log(`Fixtures: ${VALID.length} valid, ${INVALID.length} invalid`);

  // Decide mode.
  let isMock = FORCE_MOCK;
  let base = ENDPOINT;
  let mock = null;

  if (!FORCE_MOCK) {
    const u = new URL(ENDPOINT);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const up = await reachable(u.hostname, port);
    if (up) {
      if (!API_KEY) {
        console.error("RATEL_CLOUD_API_KEY is required for a live run against " + ENDPOINT);
        process.exit(2);
      }
      console.log(`\x1b[1mMode:\x1b[0m live → ${ENDPOINT}`);
    } else if (FORCE_LIVE) {
      console.error(`--live requested but ${ENDPOINT} is unreachable.`);
      process.exit(2);
    } else {
      console.log(`\x1b[33mNo backend on ${ENDPOINT} — falling back to the built-in mock ingest server.\x1b[0m`);
      console.log(`(use --live to fail instead, or start your backend on that address.)`);
      isMock = true;
    }
  }

  if (isMock) {
    mock = await startMockServer(validate);
    base = mock.base;
    console.log(`\x1b[1mMode:\x1b[0m mock → ${base}`);
  }

  try {
    await runTs({ base, isMock, RatelCloud, sendBatch });
    await runPython({ base, isMock });
    if (isMock) await assertMockWire({ buckets: mock.buckets, RatelCloud, sendBatch, base });
  } finally {
    if (mock) mock.server.close();
  }

  section("Result");
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e harness crashed:", err);
  process.exit(3);
});
