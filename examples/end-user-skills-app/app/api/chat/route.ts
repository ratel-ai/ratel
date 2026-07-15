import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getUserRuntime } from "@/lib/ratel";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_MODEL = "claude-sonnet-5";

const SYSTEM = (endUserId: string) =>
  [
    `You are the personal work assistant of end-user "${endUserId}" in a demo app`,
    "wired to Ratel: your skill catalog is synced live from Ratel Cloud, and every",
    "search/invoke you perform is real telemetry attributed to this user.",
    "",
    "Rules:",
    "- For EVERY substantive ask, FIRST call search_skills with the user's ask",
    "  (verbatim or lightly cleaned). This is how the platform learns what this",
    "  user needs — never skip it.",
    "- If a hit clearly matches the task (same task domain, decent score), call",
    "  use_skill with its skillId, then follow the returned instructions to answer.",
    "- If no hit matches, do NOT pretend a skill exists. Say the catalog has no",
    "  skill for this yet, then give a brief best-effort answer anyway.",
    "- This is a live demo: keep every answer SHORT — a few sentences, not essays.",
  ].join("\n");

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { messages?: UIMessage[]; user?: string }
    | null;
  if (!body?.user) return Response.json({ error: "Missing user." }, { status: 400 });
  if (!Array.isArray(body.messages)) {
    return Response.json({ error: "Missing messages." }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not configured for the demo app." },
      { status: 503 },
    );
  }

  const rt = await getUserRuntime(body.user);
  const anthropic = createAnthropic({ apiKey });
  const model = anthropic(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);

  const tools = {
    search_skills: tool({
      description:
        "Search this user's skill catalog (BM25, synced from Ratel Cloud) for skills " +
        "relevant to a task. Always the first call for any substantive ask.",
      inputSchema: z.object({
        query: z.string().describe("The user's ask, verbatim or lightly cleaned"),
      }),
      execute: async ({ query }) => {
        const { hits } = rt.catalog.searchTraced(query, 3, "agent");
        return {
          hits: hits.map((h) => {
            const skill = rt.catalog.get(h.skillId);
            return {
              skillId: h.skillId,
              name: skill?.name ?? h.skillId,
              description: skill?.description ?? "",
              score: Number(h.score.toFixed(2)),
            };
          }),
        };
      },
    }),
    use_skill: tool({
      description:
        "Fetch a matched skill's instructions (records a real skill_invoke for this " +
        "user). Only pass a skillId that search_skills just returned.",
      inputSchema: z.object({ skillId: z.string() }),
      execute: async ({ skillId }) => {
        try {
          const instructions = rt.catalog.invoke(skillId);
          return { name: rt.catalog.get(skillId)?.name ?? skillId, instructions };
        } catch {
          return { error: `unknown skillId: ${skillId}` };
        }
      },
    }),
  };

  const result = streamText({
    model,
    system: SYSTEM(body.user),
    messages: await convertToModelMessages(body.messages),
    tools,
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => (error instanceof Error ? error.message : "The assistant hit an error."),
  });
}
