import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type PostResult = { ok: true } | { ok: false; error: string };

/** Posts a JSON body to a webhook. Never throws. */
export type PostWebhook = (url: URL, body: unknown) => Promise<PostResult>;

const TIMEOUT_MS = 5_000;
/** Slack's own error codes ("no_service"); anything else in an answer is not repeated. */
const SLACK_CODE = /^[a-z_]{1,40}$/;
const MAX_ANSWER_BYTES = 200;

/**
 * One POST with one deadline for the whole exchange. A redirect is an answer, not followed. Through
 * `node:https` and not `fetch`: the fetch spans (Next's and undici's) carry the URL, and the URL is
 * the secret.
 */
export function postWebhook(
  url: URL,
  body: unknown,
  timeoutMs: number = TIMEOUT_MS,
): Promise<PostResult> {
  const payload = JSON.stringify(body);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const request = send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        let answer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (answer.length < MAX_ANSWER_BYTES) answer += chunk;
        });
        response.on("error", (error) => resolve(failure(error, timeoutMs)));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve({ ok: true });
          const code = SLACK_CODE.test(answer.trim()) ? ` (${answer.trim()})` : "";
          resolve({ ok: false, error: `Slack answered ${status}${code}.` });
        });
      },
    );
    request.on("error", (error) => resolve(failure(error, timeoutMs)));
    request.end(payload);
  });
}

/** By the error's kind: its message can name the address. */
function failure(error: Error, timeoutMs: number): PostResult {
  const timedOut = error.name === "AbortError" || error.name === "TimeoutError";
  return {
    ok: false,
    error: timedOut
      ? `Slack did not answer in ${timeoutMs / 1000} seconds.`
      : "Slack could not be reached.",
  };
}
