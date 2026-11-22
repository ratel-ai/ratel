import { Badge } from "@ratel/design-system/badge";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import type { ReactNode } from "react";
import {
  RUN_SETTING_KEYS,
  RUN_SETTING_LABELS,
  type RunSettingKey,
} from "@/lib/views/evals/domain/run-settings";
import type { Eval, EvalSpecField } from "@/lib/views/evals/domain/types";
import type { RunSettingsModel } from "@/lib/views/evals/run-settings";
import {
  type RuleWithSource,
  SOURCE_ORDER,
  SOURCE_RULES,
  SPEC_FIELD_LABELS,
} from "@/lib/views/evals/test-view";
import type { TaskTag } from "@/lib/views/evals/view";
import type { EvalScorerSwitch } from "@/lib/views/scorers/page";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { GeneratedMark, SourceNote } from "./marks";

/**
 * The Definition tab (D3): what the eval is, no results. RC-657: the four
 * groups of the UX audit (RC-656) in the editor's order: Scenario,
 * Environment, Expectations, Run settings. Edit is on the header only.
 */
export function EvalDefinition({
  item,
  tasks,
  rules,
  scorers = [],
  runSettings = null,
}: {
  item: Eval;
  tasks: readonly TaskTag[];
  rules: readonly RuleWithSource[];
  /** RC-615: the task and suite scorers this eval reads, with its switches. */
  scorers?: readonly EvalScorerSwitch[];
  /** RC-653: this eval's run settings; null leaves the group out. */
  runSettings?: RunSettingsModel | null;
}) {
  const generated = new Set(item.generated ?? []);
  const label = (field: EvalSpecField) => (
    <span className="flex items-center gap-2 text-xs text-fg-subtle">
      {SPEC_FIELD_LABELS[field]}
      {generated.has(field) ? <GeneratedMark /> : null}
    </span>
  );
  const spec = item.generated !== undefined;
  const context = Object.entries(item.context ?? {});
  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <Section title="Scenario" description="What the agent is asked.">
        <div className="flex flex-col gap-2 text-ui" data-group="scenario">
          {spec ? (
            <>
              {label("systemPrompt")}
              <p className="whitespace-pre-wrap rounded-md border border-line px-3 py-2 text-fg">
                {item.systemPrompt || "None."}
              </p>
            </>
          ) : null}
          {item.earlierMessages.length > 0 ? (
            <>
              <p className="text-xs text-fg-subtle">
                Earlier messages · given as history, not tested
              </p>
              {item.earlierMessages.map((message, index) =>
                message.role === "tool" ? (
                  <Line
                    key={index}
                    label="Tool call"
                    text={`${message.tool ?? ""} → ${message.text}`}
                    mono
                  />
                ) : (
                  <Line
                    key={index}
                    label={message.role === "user" ? "Person" : "Agent"}
                    text={message.text}
                  />
                ),
              )}
            </>
          ) : null}
          {spec ? label("message") : <p className="text-xs text-fg-subtle">Tested message</p>}
          <Line label="Turn 1" text={item.message || "The recorded ask was not captured."} />
          {item.turns.map((turn, index) => (
            <Line
              key={index}
              label={`Turn ${index + 2}`}
              text={turn.kind === "person" ? `Simulated person: ${turn.description}` : turn.text}
            />
          ))}
          {item.turns.some((turn) => turn.kind === "person") ? (
            <p className="text-fg-muted">
              A simulated person writes its turns, so this eval runs 3 times and reports how many
              passed.
            </p>
          ) : null}
        </div>
      </Section>

      <Section title="Environment" description="What the agent has.">
        <div className="flex flex-col gap-2 text-ui" data-group="environment">
          {spec ? (
            <>
              <p className="text-xs text-fg-subtle">
                Used when the recording lacks an input. The recording wins when it has one.
              </p>
              {label("tools")}
              {(item.tools ?? []).length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {item.tools!.map((tool) => (
                    <Badge key={tool.name}>{tool.name}</Badge>
                  ))}
                </span>
              ) : (
                <p className="text-fg-muted">None.</p>
              )}
              {label("context")}
              {context.length > 0 ? (
                context.map(([name, value]) => <Line key={name} label={name} text={value} mono />)
              ) : (
                <p className="text-fg-muted">None.</p>
              )}
            </>
          ) : null}
          <p className="text-xs text-fg-subtle">Fixed answers</p>
          {item.fixedAnswers.length > 0 ? (
            item.fixedAnswers.map((answer, index) => (
              <Line
                key={index}
                label="Fixed"
                mono
                text={`${answer.tool}${answer.when ? ` when ${JSON.stringify(answer.when)}` : ""} → ${typeof answer.result === "string" ? answer.result : JSON.stringify(answer.result)}${answer.why ? ` · ${answer.why}` : ""}`}
              />
            ))
          ) : (
            <p className="text-fg-muted">
              None. Every call gets the recorded answer, or a simulated one.
            </p>
          )}
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

      <Section title="Expectations" description="What a good run is.">
        <div className="flex flex-col gap-3 text-ui" data-group="expectations">
          {tasks.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-xs text-fg-subtle">Tasks</span>
              {tasks.map((task) => (
                <Badge key={task.id}>{task.label}</Badge>
              ))}
            </span>
          ) : (
            <p className="text-fg-muted">No task. Only the scorers of this eval apply.</p>
          )}
          {rules.length > 0 || scorers.length > 0 ? (
            <table className="w-full text-ui">
              <thead>
                <tr className="text-left text-xs text-fg-subtle">
                  <th className="w-44 pb-2 font-normal">Scorer</th>
                  <th className="pb-2 font-normal">When it passes</th>
                  <th className="w-28 pb-2 font-normal">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line border-t border-line">
                {rules.map((rule) => (
                  <tr key={rule.scorer.kind}>
                    <td className="py-2 text-fg">{SCORER_LABELS[rule.scorer.kind]}</td>
                    <td className="py-2 text-fg">{rule.sentence}</td>
                    <td className="py-2 text-fg-muted">
                      {rule.setBy === "eval" ? "This eval" : "Its task"}
                    </td>
                  </tr>
                ))}
                {scorers.map((scorer) => (
                  <tr key={scorer.id} data-eval-scorer={scorer.id}>
                    <td className={scorer.on ? "py-2 text-fg" : "py-2 text-fg-muted"}>
                      {scorer.name}
                    </td>
                    <td className="py-2 text-fg-muted">
                      {scorer.on ? "Its own rule" : "Off for this eval"}
                    </td>
                    <td className="py-2 text-fg-muted">
                      {scorer.scope === "suite" ? "Suite" : "Its task"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-fg-muted">No scorers yet.</p>
          )}
        </div>
      </Section>

      {runSettings ? (
        <Section title="Run settings" description="The models and limits of this eval's runs.">
          <dl
            className="grid grid-cols-1 gap-x-6 gap-y-1 text-ui sm:grid-cols-2"
            data-group="run-settings"
          >
            {RUN_SETTING_KEYS.map((key) => {
              const { value, source } = settingValue(runSettings, key);
              return (
                <Setting key={key} label={RUN_SETTING_LABELS[key]} value={value} source={source} />
              );
            })}
          </dl>
        </Section>
      ) : null}
    </div>
  );
}

/** One setting's value and where it comes from: this eval, or the suite default. */
function settingValue(
  model: RunSettingsModel,
  key: RunSettingKey,
): { value: string; source: string | null } {
  const own = model.own[key];
  if (own !== undefined) return { value: String(own), source: "This eval" };
  const inherited = model.inherited[key];
  return {
    value:
      inherited === null
        ? key === "agentModel"
          ? "recorded model"
          : "model default"
        : String(inherited),
    source: "Suite default",
  };
}

function Setting({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source: string | null;
}): ReactNode {
  return (
    <div className="flex items-baseline gap-1.5 py-1" data-setting={label}>
      <dt className="w-32 shrink-0 text-fg-muted">{label}</dt>
      <dd className="font-mono text-fg">{value}</dd>
      {source ? <SourceNote>{source}</SourceNote> : null}
    </div>
  );
}

function Line({ label, text, mono = false }: { label: string; text: string; mono?: boolean }) {
  return (
    <div className="flex gap-4 rounded-md border border-line px-3 py-2">
      <span className="w-16 shrink-0 text-fg-subtle">{label}</span>
      <span className={mono ? "break-all font-mono text-xs text-fg" : "text-fg"}>{text}</span>
    </div>
  );
}
