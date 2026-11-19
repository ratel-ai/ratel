/**
 * Where hosts differ, read the same way for every view. Each host fills the
 * MCP Apps host context its own way (basic-host, MCPJam, Claude, ChatGPT and
 * VS Code each leave out different optional parts) and supports a different
 * set of requests; the bridge (bridge.tsx) goes through these functions so a
 * view never has to know which host it is in. Pure over a small style target,
 * so host-adapt.test.ts runs them without a DOM.
 */
import type { McpUiAppCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { HostRequestError } from "./host-client";
import type { ToolFailure } from "./state";

export type DisplayMode = "inline" | "fullscreen" | "pip";

/**
 * Every view lays out inline and in fullscreen; hosts that read the app's
 * modes offer fullscreen only when it is declared. Not pip: the views are not
 * built for a thumbnail.
 */
export const APP_CAPABILITIES = {
  availableDisplayModes: ["inline", "fullscreen"] as DisplayMode[],
} satisfies McpUiAppCapabilities;

/** The part of an element's style the adapters write. */
export interface StyleTarget {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

/*
 * The host's styles (context.styles: its --font-*, --color-* variables and
 * @font-face CSS) are deliberately not applied. A view looks like the console:
 * Geist, inlined by the build, on the console's app surface (view.css). It
 * follows only the host's light or dark theme (bridge.tsx applyTheme).
 */

const DIMENSIONS = ["height", "maxHeight", "width", "maxWidth"] as const;
const INSETS = ["top", "right", "bottom", "left"] as const;

function cssName(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The host's frame as CSS variables: --host-height (fixed, as in fullscreen),
 * --host-max-height, --host-width, --host-max-width, and --host-safe-top/…
 * for the insets a mobile host keeps clear. A host that switches from a fixed
 * height to a flexible one sends a new containerDimensions without `height`:
 * the stale value goes, or a view sized on it would keep the old height.
 */
export function applyContainer(context: McpUiHostContext, style: StyleTarget): void {
  const dimensions = context.containerDimensions as Record<string, number | undefined> | undefined;
  if (dimensions) {
    for (const key of DIMENSIONS) {
      const value = dimensions[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0)
        style.setProperty(`--host-${cssName(key)}`, `${value}px`);
      else style.removeProperty(`--host-${cssName(key)}`);
    }
  }
  const insets = context.safeAreaInsets as Record<string, number | undefined> | undefined;
  if (insets) {
    for (const key of INSETS) {
      const value = insets[key];
      style.setProperty(
        `--host-safe-${key}`,
        `${typeof value === "number" && value > 0 ? value : 0}px`,
      );
    }
  }
}

const MODES: readonly DisplayMode[] = ["inline", "fullscreen", "pip"];

/**
 * The display modes the host offers. Hosts that say nothing are inline only;
 * a list without inline still gets it (every host renders inline), and modes
 * this protocol does not know are dropped.
 */
export function readDisplayModes(available: unknown): readonly DisplayMode[] {
  if (!Array.isArray(available)) return ["inline"];
  const modes = MODES.filter((mode) => mode === "inline" || available.includes(mode));
  return modes;
}

export function readDisplayMode(mode: unknown, fallback: DisplayMode): DisplayMode {
  return MODES.includes(mode as DisplayMode) ? (mode as DisplayMode) : fallback;
}

const METHOD_NOT_FOUND = -32601;
const TIMED_OUT = -32001;

/**
 * The host has no such method: it never will, so a view may do without it.
 * A timeout is not this: the host may still be asking the person (an
 * open-link confirmation), and a fallback would open twice.
 */
export function isMethodNotFound(cause: unknown): boolean {
  return cause instanceof HostRequestError && cause.code === METHOD_NOT_FOUND;
}

/**
 * A tools/call the host could not make, as a view shows it. A host without
 * server tools (method not found, or no answer at all) is told apart from a
 * call that failed, so the view can say to ask in the chat instead.
 */
export function toolCallFailure(cause: unknown): ToolFailure {
  if (cause instanceof HostRequestError && cause.code === METHOD_NOT_FOUND) {
    return {
      code: "host_unsupported",
      message: "This app can't run Ratel tools from the view here. Ask in the chat instead.",
    };
  }
  if (cause instanceof HostRequestError && cause.code === TIMED_OUT) {
    return {
      code: "host_timeout",
      message: "The app didn't answer in time. Try again, or ask in the chat.",
    };
  }
  return { code: "tool_error", message: cause instanceof Error ? cause.message : String(cause) };
}

/** A host answer that says it did not do what was asked ({ isError: true } on ui/open-link and ui/message). */
export function refused(result: unknown): boolean {
  return (
    !!result && typeof result === "object" && (result as { isError?: unknown }).isError === true
  );
}
