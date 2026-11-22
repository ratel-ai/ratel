import { withRequestLog } from "@/lib/platform/request-log";
import { createGitHubWebhookHandler } from "@/lib/views/code-handoff/webhook-handler";

/**
 * POST /api/github/webhook - deliveries of the Ratel GitHub App (RC-914).
 * Verifies `X-Hub-Signature-256` on the raw body, then dispatches by
 * `X-GitHub-Event`; the logic and its tests live in
 * `lib/code-handoff/webhook-handler.ts`. Node runtime for `node:crypto`.
 */
export const runtime = "nodejs";

export const POST = withRequestLog(createGitHubWebhookHandler());
