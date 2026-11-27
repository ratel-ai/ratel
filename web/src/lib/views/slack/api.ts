import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SlackAppCredentials } from "@/lib/contracts/slack-app";

export type SlackAnswer =
  | { ok: true; data: Record<string, unknown> }
  /** Slack's own code ("invalid_auth"), or one of `timeout`, `unreachable`, `bad_answer`. */
  | { ok: false; code: string };

export interface SlackCall {
  method: string;
  params?: Record<string, string>;
  auth: { token: string } | SlackAppCredentials;
}

/** Calls one Slack Web API method. Never throws, and its answer never repeats what was sent. */
export type CallSlack = (call: SlackCall) => Promise<SlackAnswer>;

const TIMEOUT_MS = 5_000;
const MAX_ANSWER_BYTES = 8_000_000;
/** Anything else in an answer is not repeated. */
export const SLACK_CODE = /^[a-z_]{1,40}$/;

/**
 * One POST with one deadline for the whole exchange; a redirect is an answer, not followed. Through
 * `node:https` and not `fetch`, as the webhook post. Slack answers 200 on failure: `ok` decides.
 */
export function slackCaller(baseUrl: string, timeoutMs: number = TIMEOUT_MS): CallSlack {
  const base = baseUrl.replace(/\/+$/, "");
  return ({ method, params = {}, auth }) =>
    new Promise((resolve) => {
      const url = new URL(`${base}/api/${method}`);
      const payload = new URLSearchParams(params).toString();
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const fail = (error: Error) => {
        const timedOut = error.name === "AbortError" || error.name === "TimeoutError";
        resolve({ ok: false, code: timedOut ? "timeout" : "unreachable" });
      };
      const request = send(
        url,
        {
          method: "POST",
          headers: {
            authorization: authorization(auth),
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(payload),
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) request.destroy(new Error("too long"));
            else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => resolve(parse(Buffer.concat(chunks).toString("utf8"))));
        },
      );
      request.on("error", fail);
      request.end(payload);
    });
}

function parse(body: string): SlackAnswer {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, code: "bad_answer" };
  }
  if (typeof data !== "object" || data === null) return { ok: false, code: "bad_answer" };
  const answer = data as Record<string, unknown>;
  if (answer.ok === true) return { ok: true, data: answer };
  const code = typeof answer.error === "string" ? answer.error : "";
  return { ok: false, code: SLACK_CODE.test(code) ? code : "bad_answer" };
}

function authorization(auth: SlackCall["auth"]): string {
  if ("token" in auth) return `Bearer ${auth.token}`;
  return `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64")}`;
}
