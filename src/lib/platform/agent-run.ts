import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { contentAttributes } from "@/lib/platform/model-call-content";

/**
 * One backend job as one agent run in Ratel Cloud's own project (RC-722): an
 * `invoke_agent <name>` root span with the job's ask, and every Ratel-paid
 * model call the job makes (`trackModelCall`, `recordTracedModelCall`) as its
 * child. Runs and Tasks then see one run per job, not one per model call.
 *
 * The root is made lazily, by the first model call, with the run's start as its
 * start: a job that calls no model exports nothing. It is a new trace
 * (`root: true`) under the model-call tracer, so lib/otel/ratel-export.ts
 * exports it with its children and the other exporters drop it.
 *
 * The run rides its own AsyncLocalStorage, not the OpenTelemetry context:
 * nothing becomes active, so database and HTTP spans keep their parents and the
 * traces the self-telemetry exporter receives keep their shape. Model-call spans name the root as
 * their parent explicitly (`agentRunParent`).
 */

export interface AgentRunMeta {
  /** The agent's name: the job kind, `label_workflows`. */
  name: string;
  /** The session the run belongs to: the job id. */
  conversationId: string;
  /** What the job was asked to do, as the run's user message. */
  ask?: string | null;
}

interface AgentRunState {
  meta: AgentRunMeta;
  startedAt: number;
  root?: Span;
}

const runs = new AsyncLocalStorage<AgentRunState>();

/** Run `work` as one agent run; hand back exactly what it returned or threw. A run inside a run joins the outer one. */
export async function withAgentRun<T>(meta: AgentRunMeta, work: () => Promise<T>): Promise<T> {
  if (runs.getStore()) return work();
  const state: AgentRunState = { meta, startedAt: Date.now() };
  let result: T;
  try {
    result = await runs.run(state, work);
  } catch (error) {
    endRoot(state, error);
    throw error;
  }
  endRoot(state);
  return result;
}

/** The context a model-call span takes its parent from: the current run's root, made on first use. Undefined outside a run. */
export function agentRunParent(tracer: Tracer): Context | undefined {
  const state = runs.getStore();
  if (!state) return undefined;
  state.root ??= startRoot(tracer, state);
  return trace.setSpan(context.active(), state.root);
}

function startRoot(tracer: Tracer, state: AgentRunState): Span {
  const { name, conversationId, ask } = state.meta;
  return tracer.startSpan(`invoke_agent ${name}`, {
    root: true,
    kind: SpanKind.INTERNAL,
    startTime: state.startedAt,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": name,
      "gen_ai.conversation.id": conversationId,
      ...(ask
        ? contentAttributes({ input: [{ role: "user", parts: [{ type: "text", content: ask }] }] })
        : {}),
    },
  });
}

function endRoot(state: AgentRunState, error?: unknown): void {
  const root = state.root;
  if (!root) return;
  try {
    if (error !== undefined) {
      root.setAttribute(
        "error.type",
        error instanceof Error ? error.constructor?.name || error.name || "Error" : typeof error,
      );
      root.setStatus({ code: SpanStatusCode.ERROR });
    }
    root.end();
  } catch {
    // A tracing failure is not the job's failure.
  }
}
