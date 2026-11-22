import { Button } from "@ratel/design-system/button";
import { Callout } from "@ratel/design-system/states";
import { useMemo } from "react";
import { useRatelView } from "../../shell/bridge";
import { fillTemplate, getPath, parseDetailConfig } from "../../shell/config";
import { DetailBody, DetailHeader } from "../../shell/detail-body";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view, { type DetailBinding } from "./bindings";

function Detail({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView<unknown, DetailBinding>();
  const binding = ratel.binding;
  const config = useMemo(
    () => (binding ? parseDetailConfig(binding.tool, binding.config) : null),
    [binding],
  );
  if (!config)
    return (
      <Callout tone="warning" title="No binding">
        This view does not know how to show {ratel.state.toolName ?? "this tool"}.
      </Callout>
    );

  const href = config.href
    ? (getPath(result.data, config.href) as string | undefined)
    : config.consolePath
      ? fillTemplate(config.consolePath, result.data, ratel.state.input)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <DetailHeader config={config} data={result.data} />
        {href ? (
          <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(href)}>
            Open in Ratel
          </Button>
        ) : null}
      </header>
      <DetailBody config={config} result={result} />
    </div>
  );
}

function DetailView() {
  return <ViewFrame>{(result) => <Detail result={result} />}</ViewFrame>;
}

mountView({ name: "detail", bindings: view.bindings }, <DetailView />);
