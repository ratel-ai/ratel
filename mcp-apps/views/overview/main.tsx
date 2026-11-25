"use client";

import { useRatelView } from "../../shell/bridge";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { HistoryBody } from "./history-body";
import { readHistoryView, readOverviewView } from "./overview";
import { OverviewBody } from "./overview-body";

/** The Overview, one widget of it, or the changes of its layout. An agent arranges, undoes and restores with the tools; nothing is arranged here. */
function Overview({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView();
  const history = readHistoryView(result);
  if (history) return <HistoryBody view={history} openInConsole={ratel.openInConsole} />;
  return <OverviewBody view={readOverviewView(result)} openInConsole={ratel.openInConsole} />;
}

mountView(
  { name: "overview", bindings: view.bindings },
  <ViewFrame>{(result) => <Overview result={result} />}</ViewFrame>,
);
