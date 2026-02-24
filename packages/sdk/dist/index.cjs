"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Agentified: () => Agentified,
  tool: () => tool
});
module.exports = __toCommonJS(index_exports);

// src/agentified.ts
var Agentified = class {
  serverUrl;
  constructor(config) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
  }
  async register(tools) {
    const serverTools = tools.map(toServerTool);
    const res = await fetch(`${this.serverUrl}/api/v1/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: serverTools })
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? `register failed (${res.status})`);
    }
    return res.json();
  }
  async prefetch(options) {
    const lastUserMsg = [...options.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return { tools: [] };
    return this.discover(lastUserMsg.content, options.topK ?? 10);
  }
  asDiscoverTool(options) {
    const limit = options?.topK ?? 10;
    return {
      name: "discover_tools",
      description: "Discover relevant tools by semantic search. Provide a query string or multiple queries.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A single search query to find relevant tools"
          },
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Multiple search queries to find relevant tools (results merged and deduplicated)"
          }
        }
      },
      execute: async (input) => {
        if (input.queries) {
          const results = await Promise.all(
            input.queries.map((q) => this.discover(q, limit))
          );
          return dedupeByName(results.flatMap((r) => r.tools));
        }
        const { tools } = await this.discover(input.query ?? "", limit);
        return tools;
      }
    };
  }
  async discover(query, limit) {
    const res = await fetch(`${this.serverUrl}/api/v1/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit })
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? `discover failed (${res.status})`);
    }
    return res.json();
  }
};
function dedupeByName(tools) {
  const map = /* @__PURE__ */ new Map();
  for (const t of tools) {
    const existing = map.get(t.name);
    if (!existing || t.score > existing.score) map.set(t.name, t);
  }
  return [...map.values()];
}
function toServerTool(def) {
  const fields = {
    name: def.name,
    description: def.description
  };
  if (def.inputSchema) fields.input_schema = JSON.stringify(def.inputSchema);
  if (def.outputSchema) fields.output_schema = JSON.stringify(def.outputSchema);
  const tool2 = {
    name: def.name,
    description: def.description,
    parameters: def.inputSchema ?? {},
    fields
  };
  if (def.metadata) tool2.metadata = def.metadata;
  return tool2;
}

// src/tool.ts
function tool(definition) {
  return { ...definition };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Agentified,
  tool
});
//# sourceMappingURL=index.cjs.map