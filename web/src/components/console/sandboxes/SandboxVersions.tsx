"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Box } from "lucide-react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { VersionRow } from "@/lib/views/sandboxes/page-model";

const STATUS: Record<VersionRow["status"], { label: string; tone: Tone }> = {
  uploading: { label: "Uploading", tone: "neutral" },
  uploaded: { label: "Waiting", tone: "neutral" },
  preparing: { label: "Preparing", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** Each pushed version with its commit and its build state, the newest first. */
export function SandboxVersions({ versions, now }: { versions: VersionRow[]; now: string }) {
  return (
    <Section title="Versions" description="A version never changes. A push makes a new one.">
      {versions.length === 0 ? (
        <EmptyState
          icon={Box}
          title="No version yet"
          description="Push a sandbox from your repository and it shows here."
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
          {versions.map((version) => (
            <li key={version.id} className="flex flex-col gap-1 px-4 py-3">
              <VersionHead version={version} now={now} />
              {version.reason ? <p className="text-ui text-fg-muted">{version.reason}</p> : null}
              <VersionSpecView spec={version.spec} />
              {version.smoke && !version.smoke.ok ? (
                <p className="text-ui text-fg-muted">
                  Smoke check: <code className="font-mono text-xs">{version.smoke.error.code}</code>
                </p>
              ) : null}
              {version.smoke?.logs ? (
                <Disclosure title="Smoke check logs">
                  <pre className="max-h-80 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
                    {version.smoke.logs}
                  </pre>
                </Disclosure>
              ) : null}
              {version.buildLog ? (
                <Disclosure title="Build log">
                  <pre className="max-h-80 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
                    {version.buildLog}
                  </pre>
                </Disclosure>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** What the version takes: the input example, the params, the tools with modes and the run mode. */
function VersionSpecView({ spec }: { spec: VersionRow["spec"] }) {
  return (
    <Disclosure
      title={`Declared: ${spec.runMode} run · ${count(spec.params.length, "parameter")} · ${count(spec.tools.length, "tool")}`}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-fg-muted">Input example</dt>
        <dd>
          <pre className="max-h-40 overflow-auto rounded-md border border-line bg-rail p-2 font-mono whitespace-pre-wrap text-fg">
            {JSON.stringify(spec.inputExample, null, 2)}
          </pre>
        </dd>
        <dt className="text-fg-muted">Parameters</dt>
        <dd className="flex flex-col gap-1">
          {spec.params.length === 0 ? <span className="text-fg-subtle">None</span> : null}
          {spec.params.map((param) => (
            <span key={param.name} className="text-fg">
              <code className="font-mono">{param.name}</code>{" "}
              <span className="text-fg-subtle">
                {param.type === "enum" ? param.options.join(" | ") : param.type}
                {param.default === null ? "" : ` = ${String(param.default)}`}
              </span>
              {param.description ? (
                <span className="text-fg-muted"> · {param.description}</span>
              ) : null}
            </span>
          ))}
        </dd>
        <dt className="text-fg-muted">Tools</dt>
        <dd className="flex flex-wrap gap-2">
          {spec.tools.length === 0 ? <span className="text-fg-subtle">None</span> : null}
          {spec.tools.map((tool) => (
            <span key={tool.name} className="inline-flex items-center gap-1.5">
              <code className="font-mono text-fg">{tool.name}</code>
              <Badge tone="neutral">{tool.mode}</Badge>
            </span>
          ))}
        </dd>
        <dt className="text-fg-muted">Run mode</dt>
        <dd className="font-mono text-fg">
          {spec.runMode}
          {spec.timeoutSeconds ? ` · timeout ${spec.timeoutSeconds} s` : ""}
        </dd>
      </dl>
    </Disclosure>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function VersionHead({ version, now }: { version: VersionRow; now: string }) {
  const status = STATUS[version.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-ui font-medium text-fg">{version.name}</span>
      <Badge tone={status.tone}>{status.label}</Badge>
      {version.commit ? (
        <code className="font-mono text-xs text-fg-muted" title={version.commit}>
          {version.commit.slice(0, 12)}
        </code>
      ) : null}
      {version.dirty ? <Badge tone="warning">Uncommitted changes</Badge> : null}
      <span className="ml-auto text-xs text-fg-subtle" title={version.createdAt}>
        {formatRelativeTime(version.createdAt, now)}
      </span>
      <code className="w-full font-mono text-xs text-fg-faint">{version.id}</code>
    </div>
  );
}
