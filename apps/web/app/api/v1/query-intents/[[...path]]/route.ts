import { INTENT_EXTRACTION_REMOVED_ON, removedEndpoint } from "@/lib/platform/http/gone";
import { withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

/**
 * `/api/v1/query-intents/**` (`POST /categorize`) was removed with intent
 * extraction. Every method answers 410 Gone; see `lib/http/gone.ts`.
 */
const handle = removedEndpoint(INTENT_EXTRACTION_REMOVED_ON);

export const GET = withRequestLog(handle);
export const HEAD = withRequestLog(handle);
export const POST = withRequestLog(handle);
export const PUT = withRequestLog(handle);
export const PATCH = withRequestLog(handle);
export const DELETE = withRequestLog(handle);
export const OPTIONS = withRequestLog(handle);
