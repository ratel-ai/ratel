import {
  acceptLedger,
  argsKey,
  capDecision,
  type FakeAnswer,
  type FakeRequest,
  GENERATION_FAILED_RESULT,
  GENERIC_RUN_FAILURE,
  lastMessages,
  matchRecorded,
  pickSimilar,
  utcDay,
} from "./domain/fake";
import type { FakeAlerts } from "./ports/fake-alerts";
import type { FakeModel } from "./ports/fake-model";
import type { FakeStore } from "./ports/fake-store";

/**
 * Answers `tool.fake.request` (spec §3.6): a pinned value, else a recorded call
 * with the same normalized arguments, else a generated value that also updates
 * the session's state ledger. A generated fake counts against the project's
 * daily cap; over it the run fails with the generic `run_failed` and an
 * internal alert fires once per project and day.
 *
 * It runs in the gateway process (`apps/gateway`), which holds the worker's
 * socket: the answer goes back on the same socket with no table round trip.
 */
export interface FakeService {
  answer(request: FakeRequest): Promise<FakeOutcome>;
}

export type FakeOutcome =
  | { kind: "answer"; answer: FakeAnswer }
  /** The run must end with this error. The error never says why. */
  | { kind: "fail_run"; error: typeof GENERIC_RUN_FAILURE };

export interface FakeServiceOptions {
  store: FakeStore;
  model: FakeModel;
  alerts: FakeAlerts;
  /** Generated fakes per project per UTC day (`SANDBOX_FAKE_DAILY_CAP`). */
  dailyCap: number;
  now?: () => Date;
  onGenerationError?: (err: unknown, request: FakeRequest) => void;
}

export function createFakeService(options: FakeServiceOptions): FakeService {
  const { store, model, alerts, dailyCap } = options;
  const now = options.now ?? (() => new Date());

  return {
    async answer(request) {
      const run = await store.runContext(request.runId);
      if (!run) return { kind: "fail_run", error: GENERIC_RUN_FAILURE };
      const key = argsKey(request.args);

      if (run.sessionId) {
        const pin = await store.pinned(run.sessionId, request.tool, key);
        if (pin) return answer(pin.result, pin.isError, "pinned");
      }

      const recordedCalls = await store.recordedCalls({
        projectId: run.projectId,
        sessionId: run.sessionId,
        tool: request.tool,
        replay: run.replay,
      });
      const recorded = matchRecorded(recordedCalls, request.args);
      if (recorded) return answer(recorded.result, recorded.isError, "recorded");

      const day = utcDay(now());
      const decision = capDecision(await store.countGenerated(run.projectId, day), dailyCap);
      if (decision !== "allow") {
        if (decision === "refuse_and_alert")
          alerts.capReached({
            projectId: run.projectId,
            organizationId: run.organizationId,
            day,
            runId: run.runId,
          });
        return { kind: "fail_run", error: GENERIC_RUN_FAILURE };
      }

      const ledger = run.sessionId ? await store.ledger(run.sessionId) : {};
      // Real results of this tool show the shape: the session's and the replay source's first, then production's.
      const examples = pickSimilar(
        [...recordedCalls, ...(await store.productionExamples(run.projectId, request.tool))],
        request.args,
      );
      let generated;
      try {
        generated = await model.generate(
          {
            request,
            examples,
            ledger,
            messages: lastMessages(request.messages ? { messages: request.messages } : run.input),
          },
          { projectId: run.projectId, organizationId: run.organizationId },
        );
      } catch (err) {
        options.onGenerationError?.(err, request);
        return answer(GENERATION_FAILED_RESULT, true, "generated");
      }
      const next = acceptLedger(generated.state);
      if (run.sessionId && next) await store.saveLedger(run.sessionId, next);
      return answer(generated.result, generated.isError, "generated");
    },
  };
}

function answer(result: unknown, isError: boolean, source: FakeAnswer["source"]): FakeOutcome {
  return { kind: "answer", answer: { result, isError, source } };
}
