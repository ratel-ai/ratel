import { getConfig } from "@/config";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { withRequestLog } from "@/lib/platform/request-log";
import { receiveWebhook } from "@/lib/views/repositories/receive";
import { linksForRepository, recordCommit } from "@/lib/views/repositories/store";

export const runtime = "nodejs";

const logger = getLogger("repositories/webhook");

/**
 * POST /api/v1/github/webhook: GitHub's push and pull_request deliveries for linked repositories
 * (RTL-408, `githubRepositories`). It authenticates by the delivery's signature, not a login or a
 * key, so it sits under `/api/v1` where a self-hosted proxy lets it through. 404 without
 * `GITHUB_WEBHOOK_SECRET`; see `lib/views/repositories/receive.ts`.
 */
export const POST = withRequestLog(async (request: Request) => {
  const result = await receiveWebhook(
    {
      event: request.headers.get("x-github-event"),
      signature: request.headers.get("x-hub-signature-256"),
      body: await request.text(),
    },
    {
      secret: getConfig().github.webhookSecret,
      linksForRepository: (id) => linksForRepository(id),
      enabled: (subject) => featureEnabled("githubRepositories", subject),
      recordCommit: (input) => recordCommit(input),
    },
  );
  if (result.status === 202 && "recorded" in result.body) {
    logger.info(
      {
        delivery: request.headers.get("x-github-delivery"),
        recorded: result.body.recorded.length,
        skipped: result.body.skipped.length,
      },
      "github_webhook_received",
    );
  }
  return result.body === null
    ? new Response(null, { status: result.status })
    : Response.json(result.body, { status: result.status });
});
