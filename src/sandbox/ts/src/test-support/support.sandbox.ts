import { tool } from "ai";
import { z } from "zod";
import { sandbox } from "../index.js";

// A sandbox with the three kinds of tools of spec §3.6: read-only, side effect and
// no hint. Each production execute records its calls. Build-excluded.

export function supportTools() {
  const calls: { tool: string; args: unknown }[] = [];
  const toolset = {
    searchDocs: tool({
      description: "Search the docs.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        calls.push({ tool: "searchDocs", args: { query } });
        return [{ slug: "install", title: `Install (${query})` }];
      },
    }),
    createTicket: tool({
      description: "Open a support ticket.",
      inputSchema: z.object({ title: z.string().min(3), body: z.string() }),
      execute: async (args) => {
        calls.push({ tool: "createTicket", args });
        return { id: "T-1" };
      },
    }),
    askExpert: tool({
      description: "Ask a sub-agent.",
      inputSchema: z.object({ question: z.string() }),
      execute: async (args) => {
        calls.push({ tool: "askExpert", args });
        return { answer: "42" };
      },
    }),
  };
  return { toolset, calls };
}

export function supportSandbox(options: { allowReal?: boolean } = {}) {
  const { toolset, calls } = supportTools();
  const defaults = { system: "Help the user.", tools: toolset };
  const t = sandbox("support-agent", {
    params: {
      system: sandbox.prompt(defaults.system),
      tools: sandbox.tools(defaults.tools, {
        searchDocs: { readOnly: true },
        createTicket: { sideEffect: true, ...(options.allowReal ? { allowReal: true } : {}) },
        askExpert: { opaque: true },
      }),
    },
    input: sandbox.chat(),
    // run() calls each tool once, as a model would, and returns what came back.
    run: async ({ params }) => {
      const out: Record<string, unknown> = {};
      for (const [name, args] of Object.entries(TOOL_ARGS)) {
        const toolOf = params.tools[name as keyof typeof params.tools];
        if (!toolOf) continue;
        try {
          out[name] = await toolOf.execute?.(
            args as never,
            {
              toolCallId: `call_${name}`,
              messages: [{ role: "user", content: "help" }],
            } as never,
          );
        } catch (err) {
          out[name] = { thrown: err instanceof Error ? err.message : String(err) };
        }
      }
      return out;
    },
  });
  return { sandbox: t, defaults, calls };
}

export const TOOL_ARGS = {
  searchDocs: { query: "install" },
  createTicket: { title: "Login fails", body: "It fails." },
  askExpert: { question: "why?" },
};
