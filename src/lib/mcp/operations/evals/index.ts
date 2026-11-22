import { z } from "zod";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { mcpActor, mcpEventContext } from "@/lib/mcp/operations/loop/tasks";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { getDb } from "@/lib/platform/db/client";
import { type ServerEventName, trackServerEvent } from "@/lib/platform/telemetry";
import { evalModelCatalog } from "@/lib/views/eval-gate/models";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";
import type { ModelCatalog, RunSettings } from "@/lib/views/evals/domain/run-settings";
import { replaySteps } from "@/lib/views/evals/domain/steps";
import {
  type Eval,
  type EvalChecks,
  type EvalResult,
  type EvalStatus,
  IN_SET_STATUSES,
} from "@/lib/views/evals/domain/types";
import { resolveSpecFiller, type SpecFiller } from "@/lib/views/evals/fill/filler";
import { completeSpec } from "@/lib/views/evals/fill/spec";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "@/lib/views/evals/gate";
import { queueEvalRun } from "@/lib/views/evals/run";
import { checkRunSettings } from "@/lib/views/evals/run-settings";
import { continueFromStep, editReplyAndRerun, setStepAnswer } from "@/lib/views/evals/steps";
import { fromLegacy, legacyScorerId } from "@/lib/views/scorers/adapters/legacy";
import { dailyRates, evalRunScores } from "@/lib/views/scorers/adapters/run-scores";
import { drizzleScorerRepository } from "@/lib/views/scorers/adapters/store";
import { ScorerConfigError } from "@/lib/views/scorers/domain/config";
import { SCORER_KINDS, SCORER_SCOPES, type Scorer } from "@/lib/views/scorers/domain/types";
import { scorersFor, upsertScorer } from "@/lib/views/task-scorers/store";
import {
  SCORER_KINDS as BUILT_IN_KINDS,
  type ScorerKind as BuiltInKind,
} from "@/lib/views/task-scorers/types";

/**
 * RC-614: the user's scorers and the agent-wide eval suite as tools, so a
 * user's agent can steer what is evaluated. Every tool is behind
 * `FF_EVALS`, decided for the caller and the project; off, each refuses as forbidden.
 * Built-in task scorers (lib/task-scorers) show in the scorer list with a
 * `legacy:` id. Their settings stay with change_task_scorer. One eval
 * switches a built-in scorer through its own checks.
 *
 * Owned (ADR-0030): the gate is the core's `FF_EVALS` (`views/evals/gate`), where upstream
 * asks `cloud-eval-gate` through the eval gate; the refusal names Evals. `evalGateEnabled` keeps
 * upstream's name so the copied tests stay upstream's.
 */

type Db = ReturnType<typeof getDb>;

export interface EvalSuiteDeps {
  evalGateEnabled: (projectId: string, actor: string) => Promise<boolean>;
  db: () => Db;
  filler: () => SpecFiller | null;
  trackServerEvent: typeof trackServerEvent;
  /** RC-653: the Claude models a run setting may name. Defaults to `evalModelCatalog()`. */
  catalog?: () => ModelCatalog;
}

export const defaultEvalSuiteDeps: EvalSuiteDeps = {
  evalGateEnabled: (projectId, actor) => evalsEnabledForActor(projectId, actor),
  db: () => getDb(),
  filler: () => resolveSpecFiller(),
  trackServerEvent,
  catalog: () => evalModelCatalog(),
};

const RATE_DAYS = 7;
const MAX_TEXT = 5_000;
const STEP_TEXT = 2_000;
const LEGACY_ID = /^legacy:(.{1,500}):([a-z_]+)$/;

const taskIdParam = z.string().trim().min(1).max(500).describe("A task id from list_tasks.");
const scorerIdParam = z.string().trim().min(1).max(600).describe("A scorer id from list_scorers.");
const evalIdParam = uuidParam().describe("An eval id from list_evals.");

export function evalSuiteReadOperations(
  deps: EvalSuiteDeps = defaultEvalSuiteDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_scorers",
      domain: "improvement",
      title: "List scorers",
      description:
        "List the scorers of one task, or the suite scorers. Each scorer has its kind, config, switch, pass threshold (0 to 1) and pass rate of the last 7 days. The id of a built-in task scorer starts with legacy:. Use change_scorer to change a scorer.",
      keywords: ["scorers", "suite scorers", "task scorers", "jsonlogic scorer", "judge scorer"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam
          .optional()
          .describe("A task id from list_tasks. Without it, the tool lists the suite scorers."),
      }),
      async execute(ctx, params) {
        await requireEvalGate(deps, ctx);
        const db = deps.db();
        const repo = drizzleScorerRepository(db);
        const own = params.taskId
          ? await repo.list(ctx.projectId, { taskId: params.taskId, scope: "task" })
          : await repo.list(ctx.projectId, { scope: "suite" });
        const builtIn = params.taskId
          ? (await scorersFor(ctx.projectId, params.taskId, db)).map((scorer) =>
              fromLegacy(params.taskId!, scorer),
            )
          : [];
        const rates = await Promise.all(
          own.map((scorer) => passRate(ctx.projectId, scorer.id, db)),
        );
        return {
          data: {
            scope: params.taskId ? "task" : "suite",
            ...(params.taskId ? { taskId: params.taskId } : {}),
            scorers: [
              ...own.map((scorer, index) => ({
                ...scorerView(scorer),
                builtIn: false,
                passRate: rates[index],
              })),
              ...builtIn.map((scorer) => ({
                ...scorerView(scorer),
                builtIn: true,
                passRate: null,
              })),
            ],
          },
          hint: "change_scorer adds, edits, removes or switches a scorer. change_eval switches one scorer off for one eval.",
        };
      },
    }),
    defineOperation({
      id: "list_evals",
      domain: "improvement",
      title: "List evals",
      description:
        "List the evals of the suite, or the evals of one task. Each eval has its ask, criteria, tasks, generated (the fields that a model wrote) and the scorers that it switches off. A suggested eval from a low score has suggestedBecause: the scorer, its value and its pass threshold. Use change_eval to change an eval.",
      keywords: ["evals", "eval suite", "agent evals"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        taskId: taskIdParam.optional(),
        status: z
          .enum(["in_set", "archived"])
          .default("in_set")
          .describe("in_set lists approved and suggested evals. archived lists removed evals."),
        limit: limitParam.describe("Maximum evals to return (max 50)."),
      }),
      async execute(ctx, params) {
        await requireEvalGate(deps, ctx);
        const db = deps.db();
        const statuses: readonly EvalStatus[] =
          params.status === "archived" ? ["archived"] : IN_SET_STATUSES;
        const items = await createDrizzleEvalStore(db).listEvals(ctx.projectId, {
          statuses,
          ...(params.taskId ? { workflowId: params.taskId } : {}),
        });
        const overrides = await drizzleScorerRepository(db).overrides(
          ctx.projectId,
          items.map((item) => item.id),
        );
        const tracker = new TruncationTracker();
        return {
          data: {
            count: items.length,
            evals: tracker
              .take(capRows(items, params.limit))
              .map((item) => evalView(item, overrides.get(item.id) ?? [], tracker)),
          },
          truncated: tracker.value,
          hint: "change_eval adds or edits an eval. run_evals runs the suite or one eval.",
        };
      },
    }),
    defineOperation({
      id: "get_eval_run",
      domain: "improvement",
      title: "Get an eval run",
      description:
        "Read one run of the suite. Each result has pass or fail, verdicts, scorer readings, generated fields and runSettings (the models and limits that it used). A result that kept its text has replay: the system prompt, the message and each step. Each tool step has a source: recorded, mock (a fixed answer) or stand-in (a simulated answer).",
      keywords: ["eval run result", "eval scores"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        runId: uuidParam().describe("A run id from run_evals."),
      }),
      async execute(ctx, params) {
        await requireEvalGate(deps, ctx);
        const db = deps.db();
        const store = createDrizzleEvalStore(db);
        const run = await store.getRun(ctx.projectId, params.runId);
        if (!run) throw notFound("eval run");
        const results = await store.listResults(ctx.projectId, run.id);
        const items = new Map(
          (await store.listEvals(ctx.projectId)).map((item) => [item.id, item]),
        );
        const names = new Map([...items].map(([id, item]) => [id, item.name]));
        const tracker = new TruncationTracker();
        const scores = await evalRunScores(ctx.projectId, run.id, db);
        const scorerNames = new Map(
          (await drizzleScorerRepository(db).list(ctx.projectId)).map((scorer) => [
            scorer.id,
            scorer.name,
          ]),
        );
        return {
          data: {
            runId: run.id,
            status: run.status,
            kind: run.kind,
            suite: run.suite,
            error: run.error,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
            results: results.map((result) => ({
              ...resultView(result, names),
              ...(result.transcript
                ? { replay: replayView(result, items.get(result.evalId), tracker) }
                : {}),
              scores: scores
                .filter((row) => row.evalId === result.evalId)
                .map((row) => ({
                  scorerId: row.scorerId,
                  name: scorerNames.get(row.scorerId) ?? null,
                  status: row.status,
                  value: row.value,
                  detail: row.detail,
                })),
            })),
          },
          truncated: tracker.value,
          hint:
            run.status === "queued" || run.status === "running"
              ? "The run is not finished. Call get_eval_run again later."
              : "change_eval with set_step_answer changes the answer of a tool step. change_eval with edit_reply changes the agent reply of an assistant step and runs from it. change_eval with continue_from_step copies the eval from a step and runs the copy.",
        };
      },
    }),
  ];
}

export function evalSuiteWriteOperations(
  deps: EvalSuiteDeps = defaultEvalSuiteDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "change_scorer",
      domain: "writes",
      title: "Change a scorer",
      description:
        "Create, update, delete, enable or disable a scorer of a task or of the suite. Kinds: check (field check) compares one run field with a value. expression (JSON rule) is JSONLogic over the run. judge (model judge) reads criteria. decision (model question) asks one closed question.",
      keywords: [
        "create scorer",
        "edit scorer",
        "jsonlogic",
        "judge criteria",
        "decision scorer",
        "suite scorer",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum(["create", "update", "delete", "enable", "disable"]),
        scorerId: scorerIdParam
          .optional()
          .describe(
            "update, delete, enable and disable: a scorer id from list_scorers. A legacy: id accepts only enable and disable.",
          ),
        scope: z.enum(SCORER_SCOPES).optional().describe("create: task or suite."),
        taskId: taskIdParam.optional().describe("create with scope task: the task id."),
        name: z.string().trim().min(1).max(120).optional(),
        kind: z
          .enum(SCORER_KINDS)
          .optional()
          .describe("create: check, expression, judge or decision."),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "check: {path, op, value}. Ops: eq, ne, lt, lte, gt, gte, contains, not_contains, matches, not_matches, exists, not_exists. expression: {logic}. judge: {criteria}. decision: {question, options: [{id, label}], pass: [ids]}.",
          ),
        goodThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("A run passes when its value is this or more. The default is 0.5."),
      }),
      async execute(ctx, params) {
        const actor = await requireEvalGate(deps, ctx);
        const db = deps.db();
        const repo = drizzleScorerRepository(db);
        const legacy = params.scorerId ? LEGACY_ID.exec(params.scorerId) : null;
        if (legacy)
          return {
            data: await switchBuiltIn(ctx, actor, db, legacy, params.action),
            hint: "list_scorers shows the task's scorers.",
          };
        if (params.action !== "create" && !params.scorerId)
          throw invalidParams(`${params.action} needs scorerId.`);
        const scorer = await saving(async () => {
          switch (params.action) {
            case "create":
              if (!params.kind || !params.config || !params.name || !params.scope)
                throw invalidParams("create needs scope, name, kind and config.");
              return repo.create({
                projectId: ctx.projectId,
                scope: params.scope,
                taskId: params.scope === "task" ? (params.taskId ?? null) : null,
                name: params.name,
                kind: params.kind,
                config: params.config as never,
                goodThreshold: params.goodThreshold,
                createdBy: actor,
              } as Parameters<typeof repo.create>[0]);
            case "update":
              return repo.update(ctx.projectId, params.scorerId!, {
                name: params.name,
                kind: params.kind,
                config: params.config,
                goodThreshold: params.goodThreshold,
                updatedBy: actor,
              });
            case "enable":
            case "disable":
              return repo.update(ctx.projectId, params.scorerId!, {
                enabled: params.action === "enable",
                updatedBy: actor,
              });
            case "delete":
              return (await repo.remove(ctx.projectId, params.scorerId!)) ? null : undefined;
          }
        });
        if (scorer === undefined || (scorer === null && params.action !== "delete"))
          throw notFound("scorer");
        await track(deps, ctx, "scorer_changed", {
          action: params.action,
          scorer_id: scorer?.id ?? params.scorerId,
          kind: scorer?.kind ?? null,
          scope: scorer?.scope ?? null,
        });
        return {
          data: {
            action: params.action,
            ...(scorer
              ? { scorer: scorerView(scorer) }
              : { scorerId: params.scorerId, deleted: true }),
          },
          hint: "run_evals runs the suite with the scorers. The daily score job reads live runs.",
        };
      },
    }),
    defineOperation({
      id: "change_eval",
      domain: "writes",
      title: "Change an eval",
      description:
        "Change an eval. create needs a name and the ask. A model writes the missing fields. Other actions: update, archive, scorer_off, scorer_on, scorer_reset. set_step_answer sets a fixed answer at a run step. continue_from_step copies the eval up to a step and runs it. edit_reply changes an agent reply at a step and runs from it. set_run_settings and set_suite_run_settings set the models and limits.",
      keywords: [
        "create eval",
        "edit eval",
        "switch scorer off",
        "archive eval",
        "set tool answer",
        "continue from step",
        "replay step",
        "eval model",
        "temperature",
        "step limit",
        "run settings",
        "edit agent reply",
        "rerun from step",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum([
          "create",
          "update",
          "archive",
          "scorer_off",
          "scorer_on",
          "scorer_reset",
          "set_step_answer",
          "continue_from_step",
          "edit_reply",
          "set_run_settings",
          "set_suite_run_settings",
        ]),
        evalId: evalIdParam
          .optional()
          .describe(
            "Every action except create and set_suite_run_settings: an eval id from list_evals.",
          ),
        name: z.string().trim().min(1).max(200).optional(),
        message: z
          .string()
          .trim()
          .min(1)
          .max(MAX_TEXT)
          .optional()
          .describe("The ask the agent gets."),
        criteria: z
          .string()
          .trim()
          .max(MAX_TEXT)
          .optional()
          .describe("What a good run does, in words. The judge reads it."),
        expectedTool: z.string().trim().max(500).nullable().optional(),
        tasks: z
          .array(taskIdParam)
          .max(20)
          .optional()
          .describe("The task ids the eval belongs to. The eval reads their scorers."),
        systemPrompt: z
          .string()
          .max(20_000)
          .nullable()
          .optional()
          .describe("update: the system prompt of the scenario."),
        context: z
          .record(z.string(), z.string().max(2_000))
          .nullable()
          .optional()
          .describe(
            "update: the context values of the environment, for example a booking reference.",
          ),
        tools: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              description: z.string().max(MAX_TEXT).default(""),
              parameters: z
                .record(z.string(), z.unknown())
                .default({ type: "object", properties: {} }),
            }),
          )
          .max(50)
          .nullable()
          .optional()
          .describe(
            "update: the tools the model gets. Each tool has a name, a description and JSON Schema parameters.",
          ),
        runId: uuidParam()
          .optional()
          .describe("set_step_answer, continue_from_step and edit_reply: a run id from run_evals."),
        step: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "set_step_answer, continue_from_step and edit_reply: a step index from the replay of get_eval_run. edit_reply needs an assistant step.",
          ),
        reply: z
          .object({
            text: z.string().max(20_000).default("").describe("The text of the agent reply."),
            calls: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(200).describe("The tool name."),
                  args: z
                    .record(z.string(), z.unknown())
                    .default({})
                    .describe("The tool arguments, as a JSON object."),
                }),
              )
              .max(20)
              .default([])
              .describe(
                "The tool calls of the reply. The new run answers them. A reply with no calls ends the run.",
              ),
          })
          .optional()
          .describe("edit_reply: the new agent reply. It needs text or one call."),
        target: z
          .enum(["this", "copy"])
          .default("this")
          .describe(
            "edit_reply: this changes this eval. copy saves a copy and leaves this eval as it is.",
          ),
        answer: z
          .string()
          .trim()
          .min(1)
          .max(MAX_TEXT)
          .optional()
          .describe(
            "set_step_answer: the answer the tool gives, as JSON or text. An answer with an error field is a failed call.",
          ),
        scorerId: scorerIdParam
          .optional()
          .describe("scorer_off, scorer_on and scorer_reset: a scorer id from list_scorers."),
        runSettings: z
          .object({
            agentModel: z
              .string()
              .trim()
              .max(100)
              .nullable()
              .optional()
              .describe("The Claude model of the agent. Null uses the model of the recorded run."),
            temperature: z
              .number()
              .min(0)
              .max(1)
              .nullable()
              .optional()
              .describe("From 0 to 1. Only 4.x agent models take a temperature."),
            maxTokens: z
              .number()
              .int()
              .min(1)
              .max(64_000)
              .nullable()
              .optional()
              .describe("The maximum tokens of one agent answer."),
            maxSteps: z
              .number()
              .int()
              .min(1)
              .max(50)
              .nullable()
              .optional()
              .describe("The maximum agent steps of one run."),
            budgetUsd: z
              .number()
              .positive()
              .max(10)
              .nullable()
              .optional()
              .describe("The maximum model cost of one run, in USD."),
            toolModel: z
              .string()
              .trim()
              .max(100)
              .nullable()
              .optional()
              .describe(
                "The Claude model that simulates a tool output that the recording does not have.",
              ),
            judgeModel: z
              .string()
              .trim()
              .max(100)
              .nullable()
              .optional()
              .describe("The Claude model of the judge."),
          })
          .strict()
          .optional()
          .describe(
            "set_run_settings and set_suite_run_settings: all the settings of that level. A missing or null setting uses the next level. An empty object clears the level.",
          ),
      }),
      async execute(ctx, params) {
        const actor = await requireEvalGate(deps, ctx);
        if (
          params.action !== "create" &&
          params.action !== "set_suite_run_settings" &&
          !params.evalId
        )
          throw invalidParams(`${params.action} needs evalId.`);
        const db = deps.db();
        const store = createDrizzleEvalStore(db);
        if (params.action === "set_suite_run_settings") {
          const checked = await checkRunSettings(
            params.runSettings ?? {},
            store,
            ctx.projectId,
            "suite",
            (deps.catalog ?? defaultEvalSuiteDeps.catalog!)(),
          );
          if (!checked.ok) throw invalidParams(checked.error);
          const saved = await store.setSuiteRunSettings(ctx.projectId, checked.value, actor);
          await track(deps, ctx, "eval_run_settings_set", {
            level: "suite",
            settings: Object.keys(saved),
          });
          return {
            data: { action: "set_suite_run_settings", runSettings: saved },
            hint: "The next run of each eval without its own setting uses these.",
          };
        }
        if (params.action === "create") {
          if (!params.name || !params.message)
            throw invalidParams("create needs name and message.");
          const spec = await completeSpec(
            {
              name: params.name,
              message: params.message,
              criteria: params.criteria ?? "",
              expectedTool: params.expectedTool ?? null,
              earlierMessages: [],
              captured: null,
            },
            deps.filler(),
          );
          const created = await store.createEval({
            projectId: ctx.projectId,
            name: params.name,
            origin: "user",
            createdBy: actor,
            status: "approved",
            criteria: params.criteria ?? "",
            expectedTool: params.expectedTool ?? null,
            tasks: params.tasks ?? [],
            ...spec,
          });
          await track(deps, ctx, "eval_created", {
            eval_id: created.id,
            generated: spec.generated,
          });
          return {
            data: { action: "create", eval: evalView(created, [], new TruncationTracker()) },
            hint: "run_evals with this evalId runs it.",
          };
        }
        const current = await store.getEval(ctx.projectId, params.evalId!);
        if (!current) throw notFound("eval");
        switch (params.action) {
          case "archive": {
            await store.setEvalStatus(ctx.projectId, current.id, "archived");
            await track(deps, ctx, "eval_removed", { eval_id: current.id });
            return {
              data: { action: "archive", evalId: current.id, status: "archived" },
              hint: "list_evals with status archived lists it.",
            };
          }
          case "update": {
            const updated = await store.updateEval(ctx.projectId, current.id, {
              name: params.name ?? current.name,
              earlierMessages: current.earlierMessages,
              turns: current.turns,
              tasks: params.tasks ?? current.tasks,
              checks: current.checks,
              expectedTool:
                params.expectedTool === undefined ? current.expectedTool : params.expectedTool,
              criteria: params.criteria ?? current.criteria,
              fixedAnswers: current.fixedAnswers,
              ...(params.message !== undefined ? { message: params.message } : {}),
              ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
              ...(params.context !== undefined ? { context: params.context } : {}),
              ...(params.tools !== undefined ? { tools: params.tools } : {}),
            });
            if (!updated) throw notFound("eval");
            await track(deps, ctx, "eval_updated", { eval_id: current.id });
            return {
              data: { action: "update", eval: evalView(updated, [], new TruncationTracker()) },
              hint: "run_evals with this evalId runs it.",
            };
          }
          case "set_step_answer": {
            if (!params.runId || params.step === undefined || !params.answer)
              throw invalidParams("set_step_answer needs runId, step and answer.");
            const saved = await setStepAnswer(
              ctx.projectId,
              actor,
              { evalId: current.id, runId: params.runId, step: params.step },
              params.answer,
              db,
            );
            if (!saved.ok) throw invalidParams(saved.error);
            await track(deps, ctx, "eval_step_answer_set", {
              eval_id: current.id,
              run_id: params.runId,
              step: params.step,
            });
            return {
              data: {
                action: "set_step_answer",
                evalId: current.id,
                fixedAnswers: saved.value.fixedAnswers.map((answer) => ({
                  tool: answer.tool,
                  when: answer.when ?? null,
                  result: answer.result,
                })),
              },
              hint: "run_evals with this evalId runs the eval with the new answer.",
            };
          }
          case "edit_reply": {
            if (!params.runId || params.step === undefined || !params.reply)
              throw invalidParams("edit_reply needs runId, step and reply.");
            const edited = await editReplyAndRerun(
              ctx.projectId,
              actor,
              { evalId: current.id, runId: params.runId, step: params.step },
              params.reply,
              params.target,
              db,
            );
            if (!edited.ok) throw invalidParams(edited.error);
            await track(deps, ctx, "eval_reply_edited", {
              eval_id: current.id,
              target: params.target,
              target_id: edited.value.item.id,
              run_id: edited.value.run.id,
              step: params.step,
            });
            return {
              data: {
                action: "edit_reply",
                target: params.target,
                eval: evalView(edited.value.item, [], new TruncationTracker()),
                openingSteps: edited.value.item.opening?.length ?? 0,
                runId: edited.value.run.id,
                created: edited.value.created,
              },
              hint: "Call get_eval_run with this runId. The replay starts with the edited reply.",
            };
          }
          case "set_run_settings": {
            const checked = await checkRunSettings(
              params.runSettings ?? {},
              store,
              ctx.projectId,
              "eval",
              (deps.catalog ?? defaultEvalSuiteDeps.catalog!)(),
            );
            if (!checked.ok) throw invalidParams(checked.error);
            const updated = await store.setEvalRunSettings(
              ctx.projectId,
              current.id,
              checked.value,
            );
            if (!updated) throw notFound("eval");
            await track(deps, ctx, "eval_run_settings_set", {
              level: "eval",
              eval_id: current.id,
              settings: Object.keys(checked.value),
            });
            return {
              data: {
                action: "set_run_settings",
                evalId: current.id,
                runSettings: updated.runSettings ?? ({} as RunSettings),
              },
              hint: "run_evals with this evalId runs it with these settings.",
            };
          }
          case "continue_from_step": {
            if (!params.runId || params.step === undefined)
              throw invalidParams("continue_from_step needs runId and step.");
            const copied = await continueFromStep(
              ctx.projectId,
              actor,
              { evalId: current.id, runId: params.runId, step: params.step },
              db,
            );
            if (!copied.ok) throw invalidParams(copied.error);
            await track(deps, ctx, "eval_continued_from_step", {
              eval_id: current.id,
              copy_id: copied.value.item.id,
              run_id: copied.value.run.id,
              step: params.step,
            });
            return {
              data: {
                action: "continue_from_step",
                eval: evalView(copied.value.item, [], new TruncationTracker()),
                earlierCount: copied.value.item.earlierMessages.length,
                runId: copied.value.run.id,
                created: copied.value.created,
              },
              hint: "Call get_eval_run with this runId.",
            };
          }
          default: {
            if (!params.scorerId) throw invalidParams(`${params.action} needs scorerId.`);
            const enabled = params.action === "scorer_reset" ? null : params.action === "scorer_on";
            await switchForEval(ctx, actor, db, current, params.scorerId, enabled);
            await track(deps, ctx, "eval_scorer_switched", {
              eval_id: current.id,
              scorer_id: params.scorerId,
              enabled,
            });
            return {
              data: {
                action: params.action,
                evalId: current.id,
                scorerId: params.scorerId,
                enabled,
              },
              hint: "The next run of this eval reads the change.",
            };
          }
        }
      },
    }),
    defineOperation({
      id: "run_evals",
      domain: "writes",
      title: "Run evals",
      description:
        "Queue a run of the suite, of the evals of one task, or of one eval. A run spends model budget. The result has runId. Use get_eval_run to read the run.",
      keywords: ["run evals", "run eval suite", "queue eval run"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        evalId: evalIdParam.optional(),
        taskId: taskIdParam.optional(),
      }),
      async execute(ctx, params) {
        const actor = await requireEvalGate(deps, ctx);
        if (params.evalId && params.taskId) throw invalidParams("Give evalId or taskId, not both.");
        const db = deps.db();
        let only: { id: string; name: string } | null = null;
        if (params.evalId) {
          const item = await createDrizzleEvalStore(db).getEval(ctx.projectId, params.evalId);
          if (!item || item.status === "archived") throw notFound("eval");
          only = { id: item.id, name: item.name };
        }
        const queued = await queueEvalRun(
          ctx.projectId,
          actor,
          params.taskId ?? null,
          db,
          "manual",
          undefined,
          only,
        );
        if (!queued.ok) throw new McpOperationError("conflict", queued.error);
        if (queued.value.created)
          await track(deps, ctx, "eval_run_queued", {
            run_id: queued.value.run.id,
            eval_count: queued.value.run.evalCount,
            workflow_id: params.taskId ?? null,
          });
        return {
          data: {
            runId: queued.value.run.id,
            status: queued.value.run.status,
            evalCount: queued.value.run.evalCount,
            created: queued.value.created,
          },
          hint: "Call get_eval_run with this runId. A queued run starts within a minute.",
        };
      },
    }),
  ];
}

async function requireEvalGate(deps: EvalSuiteDeps, ctx: OperationContext): Promise<string> {
  const actor = mcpActor(ctx.auth, ctx.projectId);
  if (!(await deps.evalGateEnabled(ctx.projectId, actor))) throw evalsOff();
  return actor;
}

async function track(
  deps: EvalSuiteDeps,
  ctx: OperationContext,
  event: ServerEventName,
  properties: Record<string, unknown>,
) {
  await deps.trackServerEvent(event, mcpEventContext(ctx), {
    object_action: event,
    surface: "mcp",
    ...properties,
  });
}

/** A config error is the caller's: it says what to fix. */
async function saving<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ScorerConfigError) throw invalidParams(err.message);
    throw err;
  }
}

async function passRate(projectId: string, scorerId: string, db: Db) {
  const since = new Date(Date.now() - RATE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const days = (await dailyRates(projectId, scorerId, db)).filter((day) => day.day >= since);
  const n = days.reduce((sum, day) => sum + day.n, 0);
  return n === 0 ? null : { n, passed: days.reduce((sum, day) => sum + day.passed, 0) };
}

/** A built-in scorer's switch, saved as change_task_scorer saves it. */
async function switchBuiltIn(
  ctx: OperationContext,
  actor: string,
  db: Db,
  match: RegExpExecArray,
  action: string,
) {
  if (action !== "enable" && action !== "disable")
    throw invalidParams(
      "A built-in scorer accepts only enable and disable. Use change_task_scorer to change its setting.",
    );
  const [, taskId, kind] = match;
  const scorer = (await scorersFor(ctx.projectId, taskId!, db)).find((item) => item.kind === kind);
  if (!scorer) throw notFound("scorer");
  const { enabled: _enabled, source: _source, version: _version, ...definition } = scorer;
  await upsertScorer(
    {
      projectId: ctx.projectId,
      taskId: taskId!,
      scorer: definition,
      enabled: action === "enable",
      source: "user",
      updatedBy: actor,
    },
    db,
  );
  return { action, scorerId: legacyScorerId(taskId!, scorer.kind), enabled: action === "enable" };
}

/** One eval's switch: an override row for a user scorer, the eval's own check for a built-in one. */
async function switchForEval(
  ctx: OperationContext,
  actor: string,
  db: Db,
  item: Eval,
  scorerId: string,
  enabled: boolean | null,
) {
  const legacy = LEGACY_ID.exec(scorerId);
  if (!legacy) {
    try {
      await drizzleScorerRepository(db).setOverride(
        ctx.projectId,
        item.id,
        scorerId,
        enabled,
        actor,
      );
    } catch (err) {
      if (err instanceof ScorerConfigError) throw new McpOperationError("not_found", err.message);
      throw err;
    }
    return;
  }
  const kind = legacy[2] as BuiltInKind;
  if (!(BUILT_IN_KINDS as readonly string[]).includes(kind)) throw notFound("scorer");
  const checks: EvalChecks = { ...item.checks };
  if (enabled === null) delete checks[kind];
  else checks[kind] = { ...checks[kind], on: enabled };
  await createDrizzleEvalStore(db).updateEval(ctx.projectId, item.id, {
    name: item.name,
    earlierMessages: item.earlierMessages,
    turns: item.turns,
    tasks: item.tasks,
    checks,
    expectedTool: item.expectedTool,
    criteria: item.criteria,
    fixedAnswers: item.fixedAnswers,
  });
}

function scorerView(scorer: Scorer) {
  return {
    id: scorer.id,
    name: scorer.name,
    kind: scorer.kind,
    scope: scorer.scope,
    taskId: scorer.taskId,
    enabled: scorer.enabled,
    goodThreshold: scorer.goodThreshold,
    version: scorer.version,
    config: scorer.config,
  };
}

function evalView(
  item: Eval,
  overrides: readonly { scorerId: string; enabled: boolean }[],
  tracker: TruncationTracker,
) {
  const builtInOff = Object.entries(item.checks).flatMap(([kind, check]) =>
    check && !check.on ? item.tasks.map((task) => legacyScorerId(task, kind as BuiltInKind)) : [],
  );
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    tasks: item.tasks,
    message: tracker.text(item.message, 600),
    criteria: tracker.text(item.criteria, 600),
    expectedTool: item.expectedTool,
    generated: item.generated ?? [],
    ...(item.runSettings ? { runSettings: item.runSettings } : {}),
    suggestedBecause: item.suggestionReason ?? null,
    scorersOff: [
      ...overrides.filter((override) => !override.enabled).map((override) => override.scorerId),
      ...builtInOff,
    ],
    scorersOn: overrides
      .filter((override) => override.enabled)
      .map((override) => override.scorerId),
  };
}

/** RC-641: the replay a person steps through: the system prompt, the message, then each step. */
function replayView(result: EvalResult, item: Eval | undefined, tracker: TruncationTracker) {
  return {
    systemPrompt: item?.systemPrompt ? tracker.text(item.systemPrompt, STEP_TEXT) : null,
    message: item ? tracker.text(item.message, STEP_TEXT) : null,
    toolsOffered: result.transcript!.toolsOffered,
    steps: replaySteps(result.transcript!, result.toolAnswers).map((step) =>
      step.role === "assistant"
        ? { ...step, text: tracker.text(step.text, STEP_TEXT) }
        : { ...step, content: tracker.text(step.content, STEP_TEXT) },
    ),
  };
}

/** The same shape as get_eval's eval-set results (RC-626). */
function resultView(result: EvalResult, names: ReadonlyMap<string, string>) {
  const standIns = result.toolAnswers
    .filter((answer) => answer.source === "stand-in")
    .map((answer) => answer.tool);
  return {
    evalId: result.evalId,
    name: names.get(result.evalId) ?? null,
    side: result.side,
    passed: result.passed,
    change: result.change,
    error: result.error,
    verdicts: result.verdicts,
    standIns: { count: standIns.length, tools: standIns },
    ...(result.generated && result.generated.length > 0 ? { generated: result.generated } : {}),
    ...(result.runSettings ? { runSettings: result.runSettings } : {}),
  };
}

/** Owned: Evals are off for the caller (`FF_EVALS`). */
export function evalsOff(): McpOperationError {
  return new McpOperationError("forbidden", EVALS_OFF_ERROR, { reason: "evals_off" });
}
