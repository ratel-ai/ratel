"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Checkbox, Switch } from "@ratel/design-system/checkbox";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState, useTransition } from "react";
import { saveRunSettingsAction, updateEvalAction } from "@/lib/views/evals/actions";
import {
  type EarlierForm,
  type EvalForm,
  type FixedAnswerForm,
  hasLimit,
  type SpecForm,
  type TurnForm,
} from "@/lib/views/evals/domain/edit";
import { UNTITLED_TASK } from "@/lib/views/evals/domain/task-name";
import type { EvalSpecField } from "@/lib/views/evals/domain/types";
import { evalHref } from "@/lib/views/evals/paths";
import type { RunSettingsModel } from "@/lib/views/evals/run-settings";
import { SOURCE_ORDER, SOURCE_RULES } from "@/lib/views/evals/test-view";
import type { TaskTag } from "@/lib/views/evals/view";
import { switchEvalScorerAction } from "@/lib/views/scorers/actions";
import type { EvalScorerSwitch } from "@/lib/views/scorers/page";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS, type ScorerKind } from "@/lib/views/task-scorers/types";
import { GeneratedMark } from "./marks";
import {
  type RunSettingsDraft,
  RunSettingsFields,
  runSettingsDraft,
  runSettingsHint,
  settingsOfDraft,
} from "./RunSettingsForm";

const TURN_KINDS = [
  { value: "message", label: "Fixed message" },
  { value: "person", label: "Simulated person" },
];
const EARLIER_ROLES = [
  { value: "user", label: "Person" },
  { value: "assistant", label: "Agent" },
];

/**
 * The eval editor (D4, RC-297). RC-657: the four groups of the UX audit
 * (RC-656), in the order of every eval screen: Scenario, Environment,
 * Expectations, Run settings. Advanced fields are collapsed with their value
 * in the row. One save for the whole page: the run settings and the scorer
 * switches save with the eval. Turn 1 is the recorded ask, shown and not
 * edited, unless the eval has a spec. `mockAt` scrolls to a fixed answer that
 * "Set a fixed answer for this tool" filled in.
 */
export function EvalEditor({
  projectId,
  evalId,
  message,
  initial,
  tasks,
  tools,
  hints,
  mockAt = null,
  generated = [],
  runSettings = null,
  scorers = [],
}: {
  projectId: string;
  evalId: string;
  message: string;
  initial: EvalForm;
  /** Tasks the eval can link to, the linked ones included. */
  tasks: readonly TaskTag[];
  /** Tool names the recording or its runs used, offered as suggestions. */
  tools: readonly string[];
  /** Per scorer: "From the task: ≤ 12.7 s", or null when it takes no limit. */
  hints: Readonly<Record<ScorerKind, string | null>>;
  mockAt?: number | null;
  /** RC-642: the spec fields a model wrote, marked until a person edits them. */
  generated?: readonly EvalSpecField[];
  /** RC-653: this eval's run settings; null hides the group. */
  runSettings?: RunSettingsModel | null;
  /** RC-615: the task and suite scorers this eval reads, each with its switch. */
  scorers?: readonly EvalScorerSwitch[];
}) {
  const [form, setForm] = useState(initial);
  const [settings, setSettings] = useState<RunSettingsDraft | null>(() =>
    runSettings ? runSettingsDraft(runSettings.own) : null,
  );
  const [switches, setSwitches] = useState(
    () => new Map(scorers.map((scorer) => [scorer.id, scorer.on])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toolList = useId();
  const back = evalHref(projectId, evalId, { tab: "definition" }).replace(
    "?tab=definition",
    "/definition",
  );
  const set = <K extends keyof EvalForm>(key: K, value: EvalForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = (andRun: boolean) =>
    start(async () => {
      setError(null);
      // The run settings and the switches save first, so a run this save starts uses them.
      if (
        runSettings &&
        settings &&
        JSON.stringify(settings) !== JSON.stringify(runSettingsDraft(runSettings.own))
      ) {
        const saved = await saveRunSettingsAction(projectId, evalId, settingsOfDraft(settings));
        if (!saved.ok) return setError(`Run settings: ${saved.error}`);
      }
      for (const scorer of scorers) {
        const on = switches.get(scorer.id) ?? scorer.on;
        if (on === scorer.on) continue;
        const switched = await switchEvalScorerAction(projectId, evalId, scorer.id, on);
        if (!switched.ok) return setError(`${scorer.name}: ${switched.error}`);
      }
      const result = await updateEvalAction(projectId, evalId, form, andRun);
      if (!result.ok) return setError(result.error);
      toast({ title: andRun ? "Saved. The eval is running." : "Saved." });
      router.push(
        andRun && result.value.run
          ? evalHref(projectId, evalId, { run: result.value.run.id })
          : back,
      );
      router.refresh();
    });
  const tagOf = new Map(tasks.map((task) => [task.id, task]));
  return (
    <form
      className="flex max-w-3xl flex-col gap-10"
      data-eval-editor
      onSubmit={(event) => {
        event.preventDefault();
        save(false);
      }}
    >
      <datalist id={toolList}>
        {tools.map((tool) => (
          <option key={tool} value={tool} />
        ))}
      </datalist>
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
          />
        )}
      </Field>

      <Section
        title="Scenario"
        description="What the agent is asked: its instructions, the message, and the conversation around it."
      >
        <div className="flex flex-col gap-5" data-group="scenario">
          {form.spec ? (
            <ScenarioFields
              spec={form.spec}
              generated={generated}
              onChange={(spec) => set("spec", spec)}
            />
          ) : null}
          <Group
            title="Earlier messages"
            description="Given to the agent as history. Not replayed, not scored."
          >
            <div className="flex flex-col gap-2" data-section="earlier">
              {form.earlier.map((message, index) => (
                <Row
                  key={index}
                  label={
                    message.role === "tool"
                      ? "Tool call"
                      : message.role === "user"
                        ? "Person"
                        : "Agent"
                  }
                  onRemove={() => set("earlier", without(form.earlier, index))}
                >
                  {message.role === "tool" ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <Input
                          aria-label="Tool"
                          placeholder="Tool"
                          list={toolList}
                          className="w-48 font-mono"
                          value={message.tool}
                          onChange={(event) =>
                            set(
                              "earlier",
                              replace(form.earlier, index, {
                                ...message,
                                tool: event.target.value,
                              }),
                            )
                          }
                        />
                        <Input
                          aria-label="Arguments"
                          placeholder='Arguments, like {"ref": "R1"}'
                          className="font-mono"
                          value={message.args}
                          onChange={(event) =>
                            set(
                              "earlier",
                              replace(form.earlier, index, {
                                ...message,
                                args: event.target.value,
                              }),
                            )
                          }
                        />
                      </div>
                      <Textarea
                        aria-label="What it returned"
                        placeholder="What it returned"
                        className="min-h-12 font-mono"
                        value={message.text}
                        onChange={(event) =>
                          set(
                            "earlier",
                            replace(form.earlier, index, { ...message, text: event.target.value }),
                          )
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Select
                        aria-label="Who"
                        options={EARLIER_ROLES}
                        value={message.role}
                        onValueChange={(role) =>
                          set(
                            "earlier",
                            replace<EarlierForm>(form.earlier, index, {
                              role: role as "user" | "assistant",
                              text: message.text,
                            }),
                          )
                        }
                      />
                      <Textarea
                        aria-label="Message"
                        className="min-h-12"
                        value={message.text}
                        onChange={(event) =>
                          set(
                            "earlier",
                            replace(form.earlier, index, { ...message, text: event.target.value }),
                          )
                        }
                      />
                    </div>
                  )}
                </Row>
              ))}
              <span className="flex gap-1">
                <AddButton
                  onClick={() => set("earlier", [...form.earlier, { role: "user", text: "" }])}
                >
                  Earlier message
                </AddButton>
                <AddButton
                  onClick={() =>
                    set("earlier", [
                      ...form.earlier,
                      { role: "tool", tool: "", args: "", text: "" },
                    ])
                  }
                >
                  Earlier tool call
                </AddButton>
              </span>
            </div>
          </Group>
          <Group
            title="Turns"
            description="Each turn is replayed and scored, in order. An eval with a simulated person runs 3 times and reports how many passed."
          >
            <div className="flex flex-col gap-2" data-section="turns">
              <Row label="Turn 1">
                {form.spec ? (
                  <p className="rounded-md border border-line px-2.5 py-2 text-ui text-fg-muted">
                    The message above.
                  </p>
                ) : (
                  <p className="rounded-md border border-line px-2.5 py-2 text-ui text-fg">
                    {message || "The recorded ask was not captured."}
                    <span className="block text-xs text-fg-subtle">
                      The recorded ask. The replay starts from the recording.
                    </span>
                  </p>
                )}
              </Row>
              {form.turns.map((turn, index) => (
                <Row
                  key={index}
                  label={`Turn ${index + 2}`}
                  onRemove={() => set("turns", without(form.turns, index))}
                >
                  <div className="flex gap-2" data-turn-kind={turn.kind}>
                    <Select
                      aria-label="Turn kind"
                      options={TURN_KINDS}
                      value={turn.kind}
                      onValueChange={(kind) =>
                        set(
                          "turns",
                          replace<TurnForm>(form.turns, index, {
                            ...turn,
                            kind: kind as TurnForm["kind"],
                          }),
                        )
                      }
                    />
                    <Textarea
                      aria-label={turn.kind === "person" ? "Simulated person" : "Message"}
                      className="min-h-12"
                      placeholder={
                        turn.kind === "person"
                          ? "Describe the person: what they want, how they talk, when they stop."
                          : "What the person says"
                      }
                      value={turn.text}
                      onChange={(event) =>
                        set(
                          "turns",
                          replace(form.turns, index, { ...turn, text: event.target.value }),
                        )
                      }
                    />
                  </div>
                </Row>
              ))}
              <span>
                <AddButton
                  onClick={() => set("turns", [...form.turns, { kind: "message", text: "" }])}
                >
                  Turn
                </AddButton>
              </span>
            </div>
          </Group>
        </div>
      </Section>

      <Section
        title="Environment"
        description="What the agent has: its tools, the context values and the tool answers you fix."
      >
        <div className="flex flex-col gap-5" data-group="environment">
          {form.spec ? (
            <EnvironmentFields
              spec={form.spec}
              generated={generated}
              onChange={(spec) => set("spec", spec)}
            />
          ) : null}
          <Group
            title="Fixed answers"
            description="A fixed answer wins over the recording for the calls it matches."
          >
            <div className="flex flex-col gap-3" data-section="fixed-answers">
              {form.fixedAnswers.map((answer, index) => (
                <FixedAnswer
                  key={index}
                  answer={answer}
                  toolList={toolList}
                  focus={mockAt === index}
                  onChange={(next) => set("fixedAnswers", replace(form.fixedAnswers, index, next))}
                  onRemove={() => set("fixedAnswers", without(form.fixedAnswers, index))}
                />
              ))}
              <span>
                <AddButton
                  onClick={() =>
                    set("fixedAnswers", [
                      ...form.fixedAnswers,
                      { tool: "", when: "", answer: "", why: "" },
                    ])
                  }
                >
                  Fixed answer
                </AddButton>
              </span>
            </div>
          </Group>
          <Disclosure
            title="How tool answers are chosen"
            hint="Fixed, then recorded, then simulated"
          >
            <ol
              className="flex list-decimal flex-col gap-1 pl-5 text-ui text-fg-muted"
              data-answer-rules
            >
              {SOURCE_ORDER.map((source) => (
                <li key={source}>{SOURCE_RULES[source]}</li>
              ))}
            </ol>
          </Disclosure>
        </div>
      </Section>

      <Section
        title="Expectations"
        description="What a good run is: the tasks it belongs to and the scorers that read it."
      >
        <div className="flex flex-col gap-5" data-group="expectations">
          <Group title="Tasks" description="The scorers of each task apply to this eval.">
            <div className="flex flex-wrap items-center gap-2" data-section="tasks">
              {form.tasks.length === 0 ? (
                <span className="text-ui text-fg-muted">
                  No task. Only the scorers below apply.
                </span>
              ) : null}
              {form.tasks.map((id) => (
                <Badge key={id}>
                  {tagOf.get(id)?.label ?? UNTITLED_TASK}
                  <button
                    type="button"
                    aria-label={`Remove ${tagOf.get(id)?.label ?? UNTITLED_TASK}`}
                    className="ml-1 text-fg-subtle hover:text-fg"
                    onClick={() =>
                      set(
                        "tasks",
                        form.tasks.filter((task) => task !== id),
                      )
                    }
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
              <span className="flex-1" />
              <Select
                aria-label="Add a task"
                placeholder="Add a task"
                value=""
                options={tasks
                  .filter((task) => !form.tasks.includes(task.id))
                  .map((task) => ({ value: task.id, label: task.label }))}
                onValueChange={(id) => id && set("tasks", [...form.tasks, id])}
              />
            </div>
          </Group>
          <Group
            title="Scorers"
            description="Built-in scorers take a limit: empty uses the task's. Task and suite scorers can be switched off for this eval only."
          >
            <div
              className="flex flex-col divide-y divide-line border-y border-line"
              data-section="checks"
            >
              {SCORER_KINDS.map((kind) => {
                const check = form.checks[kind];
                const toggle = (on: boolean) =>
                  set("checks", { ...form.checks, [kind]: { ...check, on } });
                return (
                  <div key={kind} className="flex items-start gap-4 py-2" data-check={kind}>
                    <Checkbox
                      className="w-44 shrink-0 pt-1"
                      label={SCORER_LABELS[kind]}
                      checked={check.on}
                      onCheckedChange={toggle}
                    />
                    <div className="flex flex-1 flex-col gap-1">
                      {kind === "expected_tool" ? (
                        <Input
                          aria-label="Expected tool"
                          list={toolList}
                          className="w-60 font-mono"
                          placeholder="Tool"
                          value={form.expectedTool}
                          onChange={(event) => set("expectedTool", event.target.value)}
                        />
                      ) : kind === "judge_criteria" ? (
                        <Textarea
                          aria-label="Criteria"
                          className="min-h-12"
                          placeholder="What a good run does, in a sentence"
                          value={form.criteria}
                          onChange={(event) => set("criteria", event.target.value)}
                        />
                      ) : hasLimit(kind) ? (
                        <>
                          <Input
                            aria-label={`${SCORER_LABELS[kind]} limit`}
                            inputMode="decimal"
                            placeholder={hints[kind] ?? ""}
                            value={check.max}
                            disabled={!check.on}
                            onChange={(event) =>
                              set("checks", {
                                ...form.checks,
                                [kind]: { ...check, max: event.target.value },
                              })
                            }
                          />
                          {check.max.trim() === "" ? (
                            <span className="text-xs text-fg-subtle" data-limit-default>
                              {limitDefault(hints[kind])}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-ui text-fg-muted">No limit to set</span>
                      )}
                    </div>
                    <Badge>Built-in</Badge>
                  </div>
                );
              })}
              {scorers.map((scorer) => (
                <div
                  key={scorer.id}
                  className="flex items-center gap-4 py-2"
                  data-eval-scorer={scorer.id}
                >
                  <Switch
                    label={scorer.name}
                    checked={switches.get(scorer.id) ?? scorer.on}
                    disabled={pending}
                    className="flex-1"
                    onCheckedChange={(on) =>
                      setSwitches((current) => new Map(current).set(scorer.id, on))
                    }
                  />
                  <Badge>{scorer.scope === "suite" ? "Suite" : "Task"}</Badge>
                </div>
              ))}
            </div>
          </Group>
        </div>
      </Section>

      {runSettings && settings ? (
        <Section title="Run settings" description="The models and limits of this eval's runs.">
          <div className="flex flex-col gap-1" data-group="run-settings">
            <p className="text-ui text-fg-muted" data-run-settings-summary>
              {runSettingsHint(runSettings, settings)}
            </p>
            <Disclosure title="Change models and limits">
              <RunSettingsFields
                model={runSettings}
                draft={settings}
                onChange={setSettings}
                disabled={pending}
                narrow
              />
            </Disclosure>
          </div>
        </Section>
      ) : null}

      {error ? (
        <Callout tone="danger" title="Not saved">
          {error}
        </Callout>
      ) : null}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-app py-3">
        <Link href={back} className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
        <Button type="submit" variant="secondary" disabled={pending}>
          Save
        </Button>
        <Button type="button" variant="primary" loading={pending} onClick={() => save(true)}>
          Save and run
        </Button>
      </div>
    </form>
  );
}

/** RC-642: what the agent is told: the system prompt and the message (turn 1). */
function ScenarioFields({
  spec,
  generated,
  onChange,
}: {
  spec: SpecForm;
  generated: readonly EvalSpecField[];
  onChange: (spec: SpecForm) => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-section="spec">
      <Field label={<Label text="System prompt" field="systemPrompt" generated={generated} />}>
        {(control) => (
          <Textarea
            {...control}
            className="min-h-24"
            placeholder="No system prompt"
            value={spec.systemPrompt}
            onChange={(event) => onChange({ ...spec, systemPrompt: event.target.value })}
          />
        )}
      </Field>
      <Field
        label={<Label text="Message" field="message" generated={generated} />}
        description="Turn 1: what the person asks."
      >
        {(control) => (
          <Textarea
            {...control}
            className="min-h-12"
            value={spec.message}
            onChange={(event) => onChange({ ...spec, message: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

/**
 * RC-642: the tools (a JSON list) and the context values (a JSON object),
 * collapsed with their names in the row (UX audit P1). Each is checked when it
 * loses focus, with one sentence under it (P5).
 */
function EnvironmentFields({
  spec,
  generated,
  onChange,
}: {
  spec: SpecForm;
  generated: readonly EvalSpecField[];
  onChange: (spec: SpecForm) => void;
}) {
  const [errors, setErrors] = useState<{ tools: string | null; context: string | null }>({
    tools: null,
    context: null,
  });
  return (
    <div className="flex flex-col gap-3" data-section="environment">
      <Disclosure
        title={<Label text="Tools" field="tools" generated={generated} />}
        hint={toolsHint(spec.tools)}
        defaultOpen={errors.tools !== null}
      >
        <Field
          label="Tools as JSON"
          description='A JSON list, like [{"name": "find_booking", "description": "...", "parameters": {}}]. Empty: no tools.'
          error={errors.tools ?? undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              className="min-h-24 font-mono text-xs"
              value={spec.tools}
              onChange={(event) => onChange({ ...spec, tools: event.target.value })}
              onBlur={() =>
                setErrors((current) => ({ ...current, tools: jsonError(spec.tools, "list") }))
              }
            />
          )}
        </Field>
      </Disclosure>
      <Disclosure
        title={<Label text="Context" field="context" generated={generated} />}
        hint={contextHint(spec.context)}
        defaultOpen={errors.context !== null}
      >
        <Field
          label="Context as JSON"
          description='Named values as a JSON object, like {"booking": "R1"}. Empty: none.'
          error={errors.context ?? undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              className="min-h-12 font-mono text-xs"
              value={spec.context}
              onChange={(event) => onChange({ ...spec, context: event.target.value })}
              onBlur={() =>
                setErrors((current) => ({ ...current, context: jsonError(spec.context, "object") }))
              }
            />
          )}
        </Field>
      </Disclosure>
    </div>
  );
}

function Label({
  text,
  field,
  generated,
}: {
  text: string;
  field: EvalSpecField;
  generated: readonly EvalSpecField[];
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {text}
      {generated.includes(field) ? <GeneratedMark /> : null}
    </span>
  );
}

function FixedAnswer({
  answer,
  toolList,
  focus,
  onChange,
  onRemove,
}: {
  answer: FixedAnswerForm;
  toolList: string;
  focus: boolean;
  onChange: (next: FixedAnswerForm) => void;
  onRemove: () => void;
}) {
  const [whenError, setWhenError] = useState<string | null>(null);
  return (
    <div
      className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-line p-3"
      data-fixed-answer={answer.tool}
      {...(focus ? { "data-prefilled": true } : {})}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Tool">
          {(control) => (
            <Input
              {...control}
              list={toolList}
              className="font-mono"
              autoFocus={focus}
              value={answer.tool}
              onChange={(event) => onChange({ ...answer, tool: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="When"
          description="Arguments the call must pass, as JSON. Empty: every call."
          error={whenError ?? undefined}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              placeholder='{"seat": "14C"}'
              value={answer.when}
              onChange={(event) => onChange({ ...answer, when: event.target.value })}
              onBlur={() => setWhenError(jsonError(answer.when, "object"))}
            />
          )}
        </Field>
        <Field label="Answer" className="sm:col-span-2">
          {(control) => (
            <Textarea
              {...control}
              className="font-mono"
              value={answer.answer}
              onChange={(event) => onChange({ ...answer, answer: event.target.value })}
            />
          )}
        </Field>
        <Field label="Why" className="sm:col-span-2">
          {(control) => (
            <Input
              {...control}
              placeholder="Shown with the answer in every test"
              value={answer.why}
              onChange={(event) => onChange({ ...answer, why: event.target.value })}
            />
          )}
        </Field>
      </div>
      <IconButton label="Remove this fixed answer" icon={<X />} size="icon-sm" onClick={onRemove} />
    </div>
  );
}

/** A titled part of a group: smaller than a Section. */
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-ui font-medium text-fg">{title}</h3>
        {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  onRemove,
  children,
}: {
  label: string;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-2 text-ui text-fg-subtle">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {onRemove ? (
        <IconButton
          label={`Remove ${label.toLowerCase()}`}
          icon={<X />}
          size="icon-sm"
          onClick={onRemove}
        />
      ) : (
        <span className="w-7" />
      )}
    </div>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick}>
      <Plus aria-hidden />
      {children}
    </Button>
  );
}

/** The default of a built-in limit in words: "Uses the task limit: ≤ 12.7 s", or the hint as it is ("No limit from the task"). */
function limitDefault(hint: string | null): string {
  if (!hint) return "No limit from the task.";
  return hint.startsWith("From the task: ")
    ? `Uses the task limit: ${hint.slice("From the task: ".length)}`
    : `${hint}.`;
}

/** "22 tools: list_projects, get_project_info, …", or a word when the JSON does not read. */
function toolsHint(text: string): string {
  if (!text.trim()) return "No tools";
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return "Not a JSON list";
    const names = list.map((tool) =>
      tool && typeof tool === "object" && "name" in tool ? String(tool.name) : "?",
    );
    return `${names.length} ${names.length === 1 ? "tool" : "tools"}${names.length > 0 ? `: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}` : ""}`;
  } catch {
    return "Not valid JSON";
  }
}

/** "project_id = PRJ-2058", or a word when the JSON does not read. */
function contextHint(text: string): string {
  if (!text.trim()) return "None";
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "Not a JSON object";
    const entries = Object.entries(value);
    if (entries.length === 0) return "None";
    return (
      entries
        .slice(0, 2)
        .map(
          ([name, item]) => `${name} = ${typeof item === "string" ? item : JSON.stringify(item)}`,
        )
        .join(", ") + (entries.length > 2 ? ", …" : "")
    );
  } catch {
    return "Not valid JSON";
  }
}

/** One sentence when `text` is not empty and not a JSON list or object, else null. */
function jsonError(text: string, shape: "list" | "object"): string | null {
  if (!text.trim()) return null;
  try {
    const value = JSON.parse(text) as unknown;
    const ok =
      shape === "list"
        ? Array.isArray(value)
        : !!value && typeof value === "object" && !Array.isArray(value);
    return ok ? null : `This must be a JSON ${shape}.`;
  } catch {
    return "This is not valid JSON.";
  }
}

function replace<T>(list: readonly T[], index: number, value: T): T[] {
  return list.map((item, i) => (i === index ? value : item));
}

function without<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}
