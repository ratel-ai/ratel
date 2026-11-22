import { Badge } from "@ratel/design-system/badge";
import { formatStamp } from "@/lib/console/settings/format";
import type { ShipmentCommitsView } from "@/lib/views/code-handoff/deploy/shipment-commits";

/**
 * The commits of the linked repo next to a shipment recorded from GitHub
 * (RC-921): short sha (a link to the commit on GitHub), first line, author
 * and time. The commit whose `ratel-fix:` marker made the shipment is marked.
 */
export function ShipmentCommits({ view }: { view: ShipmentCommitsView }) {
  return (
    <section
      aria-label="Its commits"
      className="flex flex-col gap-3"
      data-shipment-commits={view.shipmentId}
    >
      <h3 className="text-xs font-medium text-fg-subtle">
        Commits in{" "}
        <a
          href={view.repo.url}
          target="_blank"
          rel="noreferrer"
          className="text-fg-muted hover:text-fg hover:underline"
        >
          {view.repo.fullName}
        </a>
      </h3>
      <ol className="flex flex-col gap-2">
        {view.commits.map((commit) => (
          <li
            key={commit.sha}
            className="flex flex-col gap-0.5"
            data-carried={commit.carried ? "true" : undefined}
          >
            <div className="flex items-center gap-2">
              <a
                href={commit.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-fg-muted hover:text-fg hover:underline"
                aria-label={`Commit ${commit.shortSha} on GitHub`}
              >
                {commit.shortSha}
              </a>
              <span className="min-w-0 truncate text-ui text-fg">
                {commit.messageHead || "No message"}
              </span>
              {commit.carried ? <Badge tone="success">Carried the fix</Badge> : null}
            </div>
            <span className="text-xs text-fg-subtle">
              {commit.authorLogin ? `${commit.authorLogin} · ` : ""}
              {formatStamp(commit.pushedAt)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
