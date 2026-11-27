import { mountView } from "../../shell/mount";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { TableBody } from "./table-body";

mountView(
  { name: "table", bindings: view.bindings },
  <ViewFrame>{(result) => <TableBody result={result} />}</ViewFrame>,
);
