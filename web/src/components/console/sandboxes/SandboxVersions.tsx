"use client";

import { Badge } from "@ratel/design-system/badge";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Box } from "lucide-react";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { VersionRow } from "@/lib/views/sandboxes/page-model";
import { sandboxHref } from "@/lib/views/sandboxes/paths";
import { VERSION_STATUS } from "./sandbox-status";

/** Each pushed version with its commit and its build state, the newest first. */
export function SandboxVersions({
  projectId,
  versions,
  now,
}: {
  projectId: string;
  versions: VersionRow[];
  now: string;
}) {
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
              <Link
                href={`${sandboxHref(projectId, version.name, "configuration")}?version=${version.id}`}
                className="w-fit text-xs text-fg-muted underline hover:text-fg"
              >
                {`Configuration: ${version.spec.runMode} run · ${count(version.spec.params.length, "parameter")} · ${count(version.spec.tools.length, "tool")}`}
              </Link>
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

/**
 * The parsed `ratel.yaml` of a version: how it runs, its input example, its params, its tools with
 * their modes, its network allow-list and its secret names.
 */
export function VersionConfiguration({ spec }: { spec: VersionRow["spec"] }) {
  return (
    <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-6 gap-y-4 rounded-lg border border-line bg-raised p-4 text-ui">
      <dt className="text-fg-muted">Run mode</dt>
      <dd className="font-mono text-fg">
        {spec.runMode}
        {spec.timeoutSeconds ? ` · timeout ${spec.timeoutSeconds} s` : ""}
      </dd>
      <dt className="text-fg-muted">Input example</dt>
      <dd>
        <pre className="max-h-60 overflow-auto rounded-md border border-line bg-rail p-2 font-mono text-xs whitespace-pre-wrap text-fg">
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
      <dd className="flex flex-wrap gap-x-4 gap-y-2">
        {spec.tools.length === 0 ? <span className="text-fg-subtle">None</span> : null}
        {spec.tools.map((tool) => (
          <span key={tool.name} className="inline-flex items-center gap-1.5">
            <code className="font-mono text-fg">{tool.name}</code>
            <Badge tone="neutral">{tool.mode}</Badge>
          </span>
        ))}
      </dd>
      <dt className="text-fg-muted">Network</dt>
      <dd className="flex flex-wrap gap-2">
        {spec.network.length === 0 ? (
          <span className="text-fg-subtle">No outbound network</span>
        ) : null}
        {spec.network.map((domain) => (
          <code key={domain} className="font-mono text-fg">
            {domain}
          </code>
        ))}
      </dd>
      <dt className="text-fg-muted">Secrets</dt>
      <dd className="flex flex-wrap gap-2">
        {spec.secrets.length === 0 ? <span className="text-fg-subtle">None</span> : null}
        {spec.secrets.map((name) => (
          <code key={name} className="font-mono text-fg">
            {name}
          </code>
        ))}
      </dd>
    </dl>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function VersionHead({ version, now }: { version: VersionRow; now: string }) {
  const status = VERSION_STATUS[version.status];
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
