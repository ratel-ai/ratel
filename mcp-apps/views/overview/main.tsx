"use client";

import { useRatelView } from "../../shell/bridge";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { readOverviewView } from "./overview";
import { OverviewBody } from "./overview-body";

/** The Overview, or one widget of it. An agent arranges it with change_overview_layout; nothing is arranged here. */
function Overview({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView();
  return <OverviewBody view={readOverviewView(result)} openInConsole={ratel.openInConsole} />;
}

mountView(
  { name: "overview", bindings: view.bindings },
  <ViewFrame>{(result) => <Overview result={result} />}</ViewFrame>,
);
