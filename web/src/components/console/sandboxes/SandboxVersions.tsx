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
  building: { label: "Building", tone: "info" },
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

function VersionHead({ version, now }: { version: VersionRow; now: string }) {
  const status = STATUS[version.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-ui font-medium text-fg">{version.name}</span>
      <Badge tone={status.tone}>{status.label}</Badge>
      <code className="font-mono text-xs text-fg-muted" title={version.commit}>
        {version.commit.slice(0, 12)}
      </code>
      {version.dirty ? <Badge tone="warning">Uncommitted changes</Badge> : null}
      <span className="ml-auto text-xs text-fg-subtle" title={version.createdAt}>
        {formatRelativeTime(version.createdAt, now)}
      </span>
      <code className="w-full font-mono text-xs text-fg-faint">{version.id}</code>
    </div>
  );
}
