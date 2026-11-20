import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  applyContainer,
  isMethodNotFound,
  readDisplayMode,
  readDisplayModes,
  refused,
  type StyleTarget,
  toolCallFailure,
} from "./host-adapt";
import { HostRequestError } from "./host-client";

/** A style target that records what is set, as the document root would hold it. */
function styleTarget(): StyleTarget & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setProperty: (name, value) => void values.set(name, value),
    removeProperty: (name) => void values.delete(name),
  };
}

const context = (value: Record<string, unknown>) => value as McpUiHostContext;

test("the host's fonts, page color and variables are not applied; only its frame is", () => {
  // Claude's host context: its own typeface, page color and @font-face CSS.
  const style = styleTarget();
  applyContainer(
    context({
      theme: "dark",
      styles: {
        variables: {
          "--font-sans": "Anthropic Sans, system-ui",
          "--font-mono": "ui-monospace",
          "--color-background-primary": "light-dark(#fff, #262624)",
          "--shadow-sm": "0 0 1px red",
        },
        css: {
          fonts: "@font-face { font-family: Anthropic Sans; src: url(https://host/f.woff2); }",
        },
      },
      containerDimensions: { maxHeight: 6000, width: 700 },
    }),
    style,
  );
  assert.deepEqual(Object.fromEntries(style.values), {
    "--host-max-height": "6000px",
    "--host-width": "700px",
  });
});

test("the container's size becomes --host-*, and a fixed height goes when the host makes it flexible", () => {
  const style = styleTarget();
  applyContainer(context({ containerDimensions: { height: 820, width: 1200 } }), style);
  assert.deepEqual(Object.fromEntries(style.values), {
    "--host-height": "820px",
    "--host-width": "1200px",
  });

  // Fullscreen back to inline: basic-host and Claude send maxHeight, no height.
  applyContainer(context({ containerDimensions: { maxHeight: 6000, width: 700 } }), style);
  assert.deepEqual(Object.fromEntries(style.values), {
    "--host-max-height": "6000px",
    "--host-width": "700px",
  });

  // A change that says nothing about the container leaves it as it was.
  applyContainer(context({ theme: "dark" }), style);
  assert.equal(style.values.get("--host-width"), "700px");
});

test("safe-area insets become padding variables, missing sides as zero", () => {
  const style = styleTarget();
  applyContainer(context({ safeAreaInsets: { top: 44, right: 0, bottom: 34 } }), style);
  assert.deepEqual(Object.fromEntries(style.values), {
    "--host-safe-top": "44px",
    "--host-safe-right": "0px",
    "--host-safe-bottom": "34px",
    "--host-safe-left": "0px",
  });
});

test("display modes: inline when the host says nothing, always inline, unknown modes dropped", () => {
  assert.deepEqual(readDisplayModes(undefined), ["inline"]);
  assert.deepEqual(readDisplayModes(["fullscreen"]), ["inline", "fullscreen"]);
  assert.deepEqual(readDisplayModes(["pip", "inline", "sidebar"]), ["inline", "pip"]);
  assert.equal(readDisplayMode("fullscreen", "inline"), "fullscreen");
  assert.equal(readDisplayMode("sidebar", "inline"), "inline");
  assert.equal(readDisplayMode(undefined, "fullscreen"), "fullscreen");
});

test("a host without tools/call is told apart from a failed call", () => {
  assert.equal(
    toolCallFailure(new HostRequestError(-32601, "Method not found")).code,
    "host_unsupported",
  );
  assert.equal(
    toolCallFailure(new HostRequestError(-32001, "tools/call timed out")).code,
    "host_timeout",
  );
  assert.deepEqual(toolCallFailure(new HostRequestError(-32603, "upstream failed")), {
    code: "tool_error",
    message: "upstream failed",
  });
  assert.equal(isMethodNotFound(new HostRequestError(-32601, "x")), true);
  assert.equal(
    isMethodNotFound(new HostRequestError(-32001, "x")),
    false,
    "a timeout is not a missing method",
  );
  assert.equal(isMethodNotFound(new Error("x")), false);
});

test("a host answer with isError is a refusal", () => {
  assert.equal(refused({ isError: true }), true);
  assert.equal(refused({}), false);
  assert.equal(refused(undefined), false);
});
