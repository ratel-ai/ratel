import { parseDerived } from "@/lib/synthesis/tool-crafter/schema-check";
import type { CraftedToolDefinition, DispatchNote } from "@/lib/synthesis/tool-crafter/types";

/**
 * The crafted definition in the three forms a customer pastes: the JSON a
 * registry takes, a TypeScript stub for `@ratel-ai/sdk`'s `tools.register`,
 * and a Python stub. Pure string builders; the handler body is the dispatch
 * notes as comments, because what the handler does is the customer's code.
 */

export function toToolJson(tool: CraftedToolDefinition): string {
  return JSON.stringify(
    {
      name: tool.name,
      description: tool.description,
      searchableDescription: tool.searchableDescription,
      inputSchema: tool.inputSchema,
      ...(tool.outputNotes ? { outputNotes: tool.outputNotes } : {}),
      dispatch: tool.dispatch,
    },
    null,
    2,
  );
}

const tsString = (text: string) => JSON.stringify(text);

/** The `mode = "x"` branches a merge of swapped siblings dispatches on, or null when the notes run in sequence. */
function modeOf(when: string): string | null {
  const m = /^mode = "([^"]+)"$/.exec(when.trim());
  return m ? m[1]! : null;
}

/** True when the crafted tool runs one source per call, picked by `mode` (a merge of swapped siblings), rather than all of them in order. */
export function switchesByMode(tool: Pick<CraftedToolDefinition, "dispatch">): boolean {
  return tool.dispatch.length > 0 && tool.dispatch.every((d) => modeOf(d.when) !== null);
}

/** The dispatch notes in handler order. */
function ordered(tool: CraftedToolDefinition): DispatchNote[] {
  return tool.dispatch
    .map((d, i) => ({ ...d, order: d.order ?? i }))
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
}

/** One source call's argument object: every crafted argument passed through, renames and derived values laid over it. */
function callArgs(
  note: DispatchNote,
  lang: "ts" | "py",
  resultOf: (sourceToolId: string) => string,
): string {
  const parts: string[] = [];
  for (const [from, to] of Object.entries(note.argumentMapping))
    parts.push(
      lang === "ts"
        ? `${JSON.stringify(from)}: args[${JSON.stringify(to)}]`
        : `${JSON.stringify(from)}: args[${JSON.stringify(to)}]`,
    );
  for (const [arg, origin] of Object.entries(note.derived ?? {})) {
    const parsed = parseDerived(origin);
    if (!parsed) continue;
    const steps = parsed.kind === "output" && parsed.path ? parsed.path.split(".") : [];
    const value =
      parsed.kind === "literal"
        ? lang === "ts"
          ? JSON.stringify(parsed.value)
          : pyLiteral(parsed.value)
        : lang === "ts"
          ? `${resultOf(parsed.sourceToolId)}${steps.map((step) => `.${step}`).join("")}`
          : `${resultOf(parsed.sourceToolId)}${steps.map((step) => `[${JSON.stringify(step)}]`).join("")}`;
    parts.push(`${JSON.stringify(arg)}: ${value}`);
  }
  if (lang === "ts") return `{ ...args${parts.length ? `, ${parts.join(", ")}` : ""} }`;
  return `{**args${parts.length ? `, ${parts.join(", ")}` : ""}}`;
}

function pyLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

const ident = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * The handler body: one call per source in dispatch order, each one's result
 * bound so a later call can take a derived argument from it; swapped-sibling
 * merges branch on `mode`. A skeleton the customer finishes, not a drop-in.
 */
function handlerBody(tool: CraftedToolDefinition, lang: "ts" | "py"): string {
  const notes = ordered(tool);
  const pad = "    ";
  const lines: string[] = [];
  const resultOf = (id: string) => `r_${ident(id)}`;
  const branches = switchesByMode(tool);
  notes.forEach((note, i) => {
    const call = `${ident(note.sourceToolId)}(${callArgs(note, lang, resultOf)})`;
    const comment = `${lang === "ts" ? "//" : "#"} ${note.sourceToolId}: ${note.when}`;
    if (branches) {
      const mode = modeOf(note.when);
      if (lang === "ts")
        lines.push(
          `${pad}${comment}`,
          `${pad}if (args.mode === ${JSON.stringify(mode)}) return await ${call};`,
        );
      else
        lines.push(
          `${pad}${comment}`,
          `${pad}if args.get("mode") == ${JSON.stringify(mode)}:`,
          `${pad}    return ${call}`,
        );
      return;
    }
    const last = i === notes.length - 1;
    if (lang === "ts")
      lines.push(
        `${pad}${comment}`,
        last
          ? `${pad}return await ${call};`
          : `${pad}const ${resultOf(note.sourceToolId)} = await ${call};`,
      );
    else
      lines.push(
        `${pad}${comment}`,
        last ? `${pad}return ${call}` : `${pad}${resultOf(note.sourceToolId)} = ${call}`,
      );
  });
  if (branches)
    lines.push(
      lang === "ts"
        ? `${pad}throw new Error("unknown mode");`
        : `${pad}raise ValueError("unknown mode")`,
    );
  return lines.join("\n");
}

export function toTypeScriptStub(tool: CraftedToolDefinition): string {
  return [
    `// ${tool.name}: crafted by Ratel from how the agent used ${tool.dispatch.map((d) => d.sourceToolId).join(" and ")}.`,
    `await runtime.tools.register({`,
    `  id: ${tsString(tool.name)},`,
    `  name: ${tsString(tool.name)},`,
    `  description: ${tsString(tool.description)},`,
    `  experimentalSearchableDescription: ${tsString(tool.searchableDescription)},`,
    `  inputSchema: ${JSON.stringify(tool.inputSchema, null, 2).replace(/\n/g, "\n  ")},`,
    `  execute: async (args) => {`,
    handlerBody(tool, "ts"),
    `  },`,
    `});`,
  ].join("\n");
}

const pyString = (text: string) => JSON.stringify(text);

export function toPythonStub(tool: CraftedToolDefinition): string {
  const schema = JSON.stringify(tool.inputSchema, null, 4)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None")
    .replace(/\n/g, "\n    ");
  return [
    `# ${tool.name}: crafted by Ratel from how the agent used ${tool.dispatch.map((d) => d.sourceToolId).join(" and ")}.`,
    `def ${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}(**args):`,
    handlerBody(tool, "py"),
    ``,
    `catalog.register(`,
    `    id=${pyString(tool.name)},`,
    `    name=${pyString(tool.name)},`,
    `    description=${pyString(tool.description)},`,
    `    searchable_description=${pyString(tool.searchableDescription)},`,
    `    input_schema=${schema},`,
    `    execute=${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")},`,
    `)`,
  ].join("\n");
}
