import assert from "node:assert/strict";
import { test } from "node:test";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Children, type ReactElement, type ReactNode } from "react";
import { DialogContent } from "../src/components/dialog";

type Props = Record<string, unknown> & { children?: ReactNode };

/** The popup's own props, from the portal DialogContent renders. */
function popupProps(props: Parameters<typeof DialogContent>[0]): Props {
  const portal = DialogContent(props) as ReactElement<Props>;
  const popup = Children.toArray(portal.props.children).find(
    (child) => (child as ReactElement).type === BaseDialog.Popup,
  ) as ReactElement<Props>;
  return popup.props;
}

test("a dialog takes its name from its title by default", () => {
  const props = popupProps({ title: "Diagnostics snapshot" });
  assert.equal("aria-label" in props, false);
  assert.equal("aria-labelledby" in props, false, "Base UI points at the title");
});

test("a label names the dialog in place of its title", () => {
  const props = popupProps({ title: "Diagnostics snapshot", label: "Ratel diagnostics" });
  assert.equal(props["aria-label"], "Ratel diagnostics");
  assert.ok("aria-labelledby" in props && props["aria-labelledby"] === undefined);
});
