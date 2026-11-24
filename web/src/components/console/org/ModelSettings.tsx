import { Badge } from "@ratel/design-system/badge";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { formatStamp, relativeTime } from "@/lib/console/settings/format";
import type { ModelSettings } from "@/lib/console/settings/models";
import type { KindSetup } from "@/lib/readings/models/explain";
import type { ModelFailureRow } from "@/lib/readings/models/schema";
import { ModelCheckPanel } from "./ModelCheckPanel";

/**
 * Organization settings > Models (ADR-0009 §13): the deployment's models, read-only. Each kind's
 * vendor and model, or why it is off; each feature's model and its last failure, in the words the
 * worker log uses; and a check that asks each kind once.
 */

/** A failure that no working call came after. */
function stillFailing(row: ModelFailureRow | undefined): row is ModelFailureRow {
  return Boolean(row && (!row.okAt || row.okAt < row.failedAt));
}

function Failure({ row, now }: { row: ModelFailureRow; now: Date }) {
  return (
    <p className="mt-1 font-sans text-xs text-danger">
      {row.message}{" "}
      <span className="text-fg-subtle" title={formatStamp(row.failedAt)}>
        {relativeTime(row.failedAt, now)}
        {row.failures > 1 ? `, ${row.failures} times` : ""}
      </span>
    </p>
  );
}

function KindSummary({ setup, offTitle }: { setup: KindSetup; offTitle: string }) {
  if (!setup.on)
    return (
      <Callout tone={setup.asked ? "warning" : "info"} title={offTitle}>
        {setup.reason}
      </Callout>
    );
  return (
    <dl className="grid max-w-2xl grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
      <dt className="text-fg-subtle">Vendor</dt>
      <dd className="min-w-0 text-fg">{setup.vendor}</dd>
      {setup.model ? (
        <>
          <dt className="text-fg-subtle">Model</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5 text-fg">{setup.model}</dd>
        </>
      ) : null}
      {setup.where ? (
        <>
          <dt className="text-fg-subtle">Where</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5 text-fg">{setup.where}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function ModelSettingsView({
  slug,
  settings,
  now,
}: {
  slug: string;
  settings: ModelSettings;
  now: Date;
}) {
  const { text, decisions, embeddings, failures } = settings;
  const decisionFailure = Object.values(failures)
    .filter((row) => row.kind === "decision")
    .find(stillFailing);
  return (
    <PageBody className="*:min-w-0">
      <p className="max-w-2xl text-ui text-fg-muted">
        This deployment's models, chosen in its environment (<code>.env</code>): change them there
        and restart. <code>web/.env.example</code> lists every setting.
      </p>
      {settings.failuresUnreadable ? (
        <Callout tone="warning" title="Couldn't read the last failures">
          The setup below is current; the failures come back once the database answers.
        </Callout>
      ) : null}

      <Section title="Text models" description="Names, fix drafts, the analyst and the eval gate.">
        <KindSummary setup={text} offTitle="No text model" />
        {text.on ? (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-ui">
              <thead className="text-xs text-fg-subtle">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Feature</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {text.features.map((row) => {
                  const failure = failures[row.feature];
                  const failing = stillFailing(failure);
                  return (
                    <tr key={row.feature} className="border-b border-line last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div className="text-fg">{row.does}</div>
                        <div className="font-mono text-xs text-fg-subtle">{row.feature}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-fg">
                        {row.model ?? <span className="text-fg-subtle">none</span>}
                        {row.reason ? (
                          <p className="mt-1 font-sans text-xs text-fg-muted">{row.reason}</p>
                        ) : null}
                        {failing ? <Failure row={failure} now={now} /> : null}
                      </td>
                      <td className="px-3 py-2">
                        {!row.model ? (
                          <Badge tone="warning">No model</Badge>
                        ) : failing ? (
                          <Badge tone="danger">Failing</Badge>
                        ) : failure ? (
                          <Badge tone="success">Working again</Badge>
                        ) : (
                          <Badge>Set up</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section
        title="Decision model"
        description="The match-quality judge, workflow decisions and topic placement."
      >
        <KindSummary setup={decisions} offTitle="No decision model" />
        {decisionFailure ? <Failure row={decisionFailure} now={now} /> : null}
      </Section>

      <Section title="Embeddings" description="The Playground's semantic search.">
        <KindSummary setup={embeddings} offTitle="No embeddings" />
      </Section>

      <ModelCheckPanel slug={slug} />
    </PageBody>
  );
}
