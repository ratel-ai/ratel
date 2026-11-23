"use client";

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
/**
 * The host bridge every view shares: one MCP Apps connection (host-client.ts),
 * the view's state (state.ts), the host's theme on the console's semantic
 * tokens, and the few things a view asks of the host.
 */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { McpAppBinding } from "@/lib/mcp/apps/types";
import {
  APP_CAPABILITIES,
  applyContainer,
  type DisplayMode,
  isMethodNotFound,
  readDisplayMode,
  readDisplayModes,
  refused,
  toolCallFailure,
} from "./host-adapt";
import { type Channel, HostClient, windowChannel } from "./host-client";
import { consoleUrl, openExternal, setLinkOpener, webUrl } from "./links";
import {
  initialViewState,
  inputProject,
  pickBinding,
  readToolResult,
  type Theme,
  type ToolFailure,
  type ToolSuccess,
  type ViewState,
  viewReducer,
  withProject,
} from "./state";

export const VIEW_VERSION = "0.1.0";

export interface RatelView<T = unknown, B extends McpAppBinding = McpAppBinding> {
  state: ViewState<T>;
  /** The binding of the tool that rendered this view. */
  binding: B | null;
  /** Null until the host connected. */
  app: HostClient | null;
  /**
   * Call another Ratel tool through the host (tools/call), read as a Ratel
   * result. The call is for the project of the call that rendered the view,
   * unless `args` names another (state.ts withProject).
   */
  callTool: <R = unknown>(
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ ok: true; value: ToolSuccess<R> } | { ok: false; error: ToolFailure }>;
  /** Open a console page ("/projects/…") in the user's browser (ui/open-link; a new window where the host has none). */
  openInConsole: (path: string) => void;
  /** Put a message in the conversation, as the user (ui/message). False when the host did not take it; never throws. */
  askAgent: (text: string) => Promise<boolean>;
  /** Tell the model what the user is looking at, without a message (ui/update-model-context). False when the host did not take it; never throws. */
  setContext: (text: string, structured?: Record<string, unknown>) => Promise<boolean>;
  /** inline, fullscreen or pip, as the host last said. */
  displayMode: DisplayMode;
  /** The modes the host offers; inline alone when it says nothing. */
  displayModes: readonly DisplayMode[];
  /** Ask the host for another mode (ui/request-display-mode); resolves to the mode it set. */
  requestDisplayMode: (mode: DisplayMode) => Promise<DisplayMode>;
}

export type { DisplayMode } from "./host-adapt";

const ViewContext = createContext<RatelView | null>(null);

export function useRatelView<T = unknown, B extends McpAppBinding = McpAppBinding>(): RatelView<
  T,
  B
> {
  const view = useContext(ViewContext);
  if (!view) throw new Error("useRatelView() must be used inside <RatelViewProvider>");
  return view as unknown as RatelView<T, B>;
}

function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** The host's theme on the document, where the view's token sets switch on it (shell/view.css). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** What a host context says about the frame: its size and safe area. Its styles are not taken (host-adapt.ts). */
function applyHostContext(context: McpUiHostContext): void {
  applyContainer(context, document.documentElement.style);
}

/**
 * A link out through the host. Only http(s). A new window only when the host
 * has no open-link at all: not on a timeout, when the host may still be
 * asking the person, so the link never opens twice or by surprise.
 */
export async function openThroughHost(
  client: Pick<HostClient, "openLink">,
  url: string,
  open: (url: string) => void = (target) => window.open(target, "_blank", "noopener,noreferrer"),
): Promise<void> {
  const safe = webUrl(url);
  if (!safe) return;
  try {
    await client.openLink({ url: safe });
  } catch (cause) {
    if (isMethodNotFound(cause)) open(safe);
  }
}

export function RatelViewProvider({
  name,
  bindings,
  children,
  channel,
}: {
  name: string;
  bindings: readonly McpAppBinding[];
  children: ReactNode;
  /** The host; the parent window unless a test passes its own. */
  channel?: Channel;
}) {
  const [state, dispatch] = useReducer(viewReducer, { ...initialViewState, theme: systemTheme() });
  const [app, setApp] = useState<HostClient | null>(null);
  const [display, setDisplay] = useState<{ mode: DisplayMode; modes: readonly DisplayMode[] }>({
    mode: "inline",
    modes: ["inline"],
  });

  useEffect(() => {
    const client = new HostClient(
      channel ?? windowChannel(),
      { name: `ratel-${name}`, version: VIEW_VERSION },
      undefined,
      APP_CAPABILITIES,
    );
    // Set before connect, so nothing the host sends right after ui/initialize is missed.
    client.ontoolinputpartial = (params) =>
      dispatch({ type: "input-partial", arguments: params.arguments });
    client.ontoolinput = (params) => dispatch({ type: "input", arguments: params.arguments });
    client.ontoolresult = (params) => dispatch({ type: "result", result: params });
    client.ontoolcancelled = (params) => dispatch({ type: "cancelled", reason: params.reason });
    client.onhostcontextchanged = (context) => {
      if (context.theme) dispatch({ type: "theme", theme: context.theme });
      if (context.displayMode || context.availableDisplayModes) {
        setDisplay((current) => ({
          mode: readDisplayMode(context.displayMode, current.mode),
          modes: context.availableDisplayModes
            ? readDisplayModes(context.availableDisplayModes)
            : current.modes,
        }));
      }
      applyHostContext(context);
    };
    let stopResize: (() => void) | null = null;
    let live = true;
    client
      .connect()
      .then((result) => {
        if (!live) return;
        const context = result.hostContext;
        dispatch({
          type: "connected",
          toolName: context?.toolInfo?.tool.name ?? null,
          theme: context?.theme ?? null,
        });
        if (context) applyHostContext(context);
        setDisplay({
          mode: readDisplayMode(context?.displayMode, "inline"),
          modes: readDisplayModes(context?.availableDisplayModes),
        });
        setLinkOpener((url) => void openThroughHost(client, url));
        stopResize = client.autoResize();
        setApp(client);
      })
      .catch((cause: unknown) => {
        if (live)
          dispatch({
            type: "connect-failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      live = false;
      stopResize?.();
      setLinkOpener(null);
      client.close();
    };
  }, [name, channel]);

  useEffect(() => applyTheme(state.theme), [state.theme]);

  // The host actions depend on the connection and the project alone, so a view's
  // effects keyed on them (the replay's step content loader, its model context)
  // do not re-run when the display mode or the tool state changes.
  const projectId = inputProject(state.input);
  const actions = useMemo(
    () => ({
      callTool: async (toolName: string, args: Record<string, unknown> = {}) => {
        if (!app)
          return {
            ok: false,
            error: { code: "host_unavailable", message: "Not connected to a host." },
          };
        try {
          return readToolResult(
            await app.callServerTool({ name: toolName, arguments: withProject(args, projectId) }),
          );
        } catch (cause) {
          return { ok: false, error: toolCallFailure(cause) };
        }
      },
      openInConsole: (path: string) => {
        const url = consoleUrl(path);
        if (app) void openThroughHost(app, url);
        else openExternal(url);
      },
      askAgent: async (text: string) => {
        if (!app) return false;
        try {
          return !refused(
            await app.sendMessage({ role: "user", content: [{ type: "text", text }] }),
          );
        } catch {
          return false;
        }
      },
      setContext: async (text: string, structured?: Record<string, unknown>) => {
        if (!app) return false;
        try {
          await app.updateModelContext({
            content: [{ type: "text", text }],
            ...(structured ? { structuredContent: structured } : {}),
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    [app, projectId],
  );

  const view = useMemo<RatelView>(
    () => ({
      state,
      binding: pickBinding(bindings, state.toolName),
      app,
      callTool: actions.callTool as RatelView["callTool"],
      openInConsole: actions.openInConsole,
      askAgent: actions.askAgent,
      setContext: actions.setContext,
      displayMode: display.mode,
      displayModes: display.modes,
      requestDisplayMode: async (mode) => {
        // Asking for a mode the host did not offer is a no-op some hosts never answer.
        if (!app || !display.modes.includes(mode)) return display.mode;
        try {
          const answer = await app.requestDisplayMode({ mode });
          const next = readDisplayMode(answer.mode, display.mode);
          setDisplay((current) => ({ ...current, mode: next }));
          return next;
        } catch {
          return display.mode;
        }
      },
    }),
    [state, bindings, app, display, actions],
  );

  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}
