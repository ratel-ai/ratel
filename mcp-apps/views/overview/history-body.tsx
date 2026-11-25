import { Button } from "@ratel/design-system/button";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight, History } from "lucide-react";
import { LayoutHistoryList } from "@/components/console/home/focused/LayoutHistoryList";
import type { OverviewHistoryView } from "./overview";

/** The console's own History list, to read. An agent undoes and restores with the tools. */
export function HistoryBody({
  view: { project, root, now, entries },
  openInConsole,
}: {
  view: OverviewHistoryView;
  openInConsole: (href: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          <span className="font-medium text-fg">History of your layout</span> · {project.name}
        </p>
        <Button variant="ghost" size="sm" onClick={() => openInConsole(root)}>
          Open in Ratel
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Button>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          icon={History}
          title="No changes yet"
          description="Each change of the layout shows here, with a way back to it."
        />
      ) : (
        <LayoutHistoryList entries={entries} now={new Date(now)} />
      )}
    </div>
  );
}
