import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { hashApiKey } from "@/lib/platform/api-keys";
import { bearerFromHeader } from "@/lib/platform/api-keys/authenticate";
import { getLogger } from "@/lib/platform/logger";
import { storable } from "@/lib/platform/storable";
import { type RunResult, runResultSchema } from "./domain/run";
import { type RunDeps, stopInstanceOf } from "./runs";

/** `POST /api/v1/sandbox-runs/[id]/result`: the runner of an instance posts the result of its run. */
export type ResultApiDeps = Pick<RunDeps, "runs" | "provider" | "now"> & {
  /** Runs the work after the response, so the runner gets its answer before its instance stops. */
  afterResponse: (work: () => Promise<void>) => void;
  onFinished?: (run: {
    id: string;
    projectId: string;
    status: RunResult["status"];
  }) => Promise<void>;
};

/** The runner sends at most 4 MB. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const logger = getLogger("sandboxes/result-api");

export async function handleRunResult(
  req: Request,
  runId: string,
  deps: ResultApiDeps,
): Promise<Response> {
  const token = bearerFromHeader(req.headers.get("authorization"));
  const owner = token ? await deps.runs.findByTokenHash(hashApiKey(token)) : null;
  if (!owner)
    return reply(401, "unauthorized", "The run token is not valid, or the run has ended.");
  // The token is for one run.
  if (owner.id !== runId) return reply(403, "forbidden", "The token is for another run.");

  return withFeatureSpan(
    "sandboxes",
    "post_result",
    async () => {
      const body = await readBody(req);
      if (!body.ok) return reply(413, "too_large", "The result is too large.");
      const parsed = runResultSchema.safeParse(body.value);
      if (!parsed.success || parsed.data.runId !== runId) {
        return reply(400, "invalid", "The body is not the result of this run.");
      }
      const result = parsed.data;
      const ended = await deps.runs.finish(runId, { status: result.status, result }, deps.now());
      if (!ended) return reply(409, "already_ended", "The run has ended.");
      logger.info(
        { project_id: owner.projectId, run_id: runId, outcome: result.status },
        "sandbox run finished",
      );
      deps.afterResponse(async () => {
        const run = await deps.runs.get(owner.projectId, runId);
        // With no instance yet, the start stops it when it sees that the run has ended.
        if (run?.instanceRef) await stopInstanceOf(run, deps);
        await deps.onFinished?.({ ...owner, status: result.status });
      });
      return Response.json({ ok: true }, { status: 202 });
    },
    { attributes: { "project.id": owner.projectId, "sandbox.run_id": runId } },
  );
}

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of (req.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) return { ok: false };
    parts.push(chunk);
  }
  try {
    // Also here: a value that is too deep to store is a wrong body.
    return { ok: true, value: storable(JSON.parse(Buffer.concat(parts).toString("utf8"))) };
  } catch {
    return { ok: true, value: null };
  }
}

function reply(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: { "cache-control": "no-store" } });
}
