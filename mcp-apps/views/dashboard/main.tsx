import { useRatelView } from "../../shell/bridge";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { Dashboard } from "./dashboard";

function Mounted({ result }: { result: ToolSuccess }) {
  const { openInConsole } = useRatelView();
  return <Dashboard result={result} openInConsole={openInConsole} />;
}

mountView(
  { name: "dashboard", bindings: view.bindings },
  <ViewFrame>{(result) => <Mounted result={result} />}</ViewFrame>,
);
