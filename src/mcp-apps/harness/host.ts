/**
 * The dev harness's host: ext-apps' own AppBridge, the reference host side of
 * MCP Apps, driving each view frame with a fixture instead of a server.
 * Bundled by scripts/mcp-apps-harness.mts; the page embeds its config.
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ViewFixture } from "../shell/types";

export interface HarnessFrame {
  theme: "light" | "dark";
  fixture: ViewFixture;
}

export interface HarnessConfig {
  view: string;
  html: string;
  frames: HarnessFrame[];
}

const FULLSCREEN_HEIGHT = 820;

function log(frame: HTMLElement, line: string): void {
  const list = frame.querySelector("[data-log]");
  if (!list) return;
  const item = document.createElement("li");
  item.textContent = line;
  list.prepend(item);
}

async function mountFrame(
  container: HTMLElement,
  config: HarnessConfig,
  frame: HarnessFrame,
): Promise<void> {
  const shell = document.createElement("section");
  shell.className = `frame frame-${frame.theme}`;
  shell.innerHTML = `<header>${frame.theme}</header><div class="slot"></div><ol data-log></ol>`;
  container.append(shell);

  const iframe = document.createElement("iframe");
  // As a host loads it: no same-origin, scripts only.
  iframe.sandbox.add("allow-scripts");
  iframe.title = `${config.view} (${frame.theme})`;
  shell.querySelector(".slot")!.append(iframe);

  const { fixture } = frame;
  let hostContext: McpUiHostContext = {
    theme: frame.theme,
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    platform: "web",
    locale: "en-US",
    containerDimensions: { maxHeight: 4000 },
    toolInfo: { tool: { name: fixture.tool, inputSchema: { type: "object" } } },
  };
  const bridge = new AppBridge(
    null,
    { name: "ratel-harness", version: "0.1.0" },
    { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } },
    { hostContext },
  );
  bridge.oncalltool = async (params) => {
    log(shell, `tools/call ${params.name} ${JSON.stringify(params.arguments ?? {})}`);
    // A fixture whose input names a project is a signed-in person's call (OAuth): the server
    // refuses their calls without one (lib/mcp/dispatch.ts resolveScope), and so does the harness.
    if (
      typeof fixture.input?.projectId === "string" &&
      typeof params.arguments?.projectId !== "string"
    ) {
      const message =
        "projectId is required for this operation. Call list_projects to see the projects you can reach.";
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { ok: false, error: "invalid_params", message },
      } as CallToolResult;
    }
    const answer = fixture.calls?.[params.name];
    return (answer ?? {
      isError: true,
      content: [{ type: "text", text: `No fixture answers ${params.name}` }],
      structuredContent: {
        ok: false,
        error: "not_found",
        message: `No fixture answers ${params.name}.`,
      },
    }) as CallToolResult;
  };
  bridge.onopenlink = async ({ url }) => {
    log(shell, `open-link ${url}`);
    return {};
  };
  bridge.onmessage = async (params) => {
    log(shell, `message ${JSON.stringify(params.content)}`);
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    log(shell, `model-context ${JSON.stringify(params.content ?? params.structuredContent)}`);
    return {};
  };
  // Fullscreen is a fixed frame the view fills (and scrolls inside); inline grows with the view.
  let mode: "inline" | "fullscreen" = "inline";
  bridge.onsizechange = ({ height }) => {
    log(shell, `size-changed ${height}`);
    if (height && mode === "inline") iframe.style.height = `${height}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode: requested }) => {
    log(shell, `request-display-mode ${requested}`);
    mode = requested === "fullscreen" ? "fullscreen" : "inline";
    shell.classList.toggle("frame-fullscreen", mode === "fullscreen");
    if (mode === "fullscreen") iframe.style.height = `${FULLSCREEN_HEIGHT}px`;
    hostContext = {
      ...hostContext,
      displayMode: mode,
      containerDimensions:
        mode === "fullscreen" ? { height: FULLSCREEN_HEIGHT } : { maxHeight: 4000 },
    };
    bridge.setHostContext(hostContext);
    return { mode };
  };
  bridge.oninitialized = () => {
    log(shell, "initialized");
    if (fixture.input) void bridge.sendToolInput({ arguments: fixture.input });
    if (fixture.cancelled) void bridge.sendToolCancelled(fixture.cancelled);
    else if (fixture.result) void bridge.sendToolResult(fixture.result as CallToolResult);
  };

  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = config.html;
}

const config = JSON.parse(document.getElementById("harness-config")!.textContent!) as HarnessConfig;
const container = document.getElementById("frames")!;
for (const frame of config.frames) void mountFrame(container, config, frame);
