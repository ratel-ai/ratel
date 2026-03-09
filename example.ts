/* ──────────────────────────────────────────────────────────
 * Minimal — no scoping, just tool discovery
 * ────────────────────────────────────────────────────────── */

import { Agent } from 'mastra';
import { Agentified } from '@agentified/mastra';

const ag = new Agentified();
await ag.connect();

const instance = await ag.registerTools({ tools: [/* ... */] });

const agent = new Agent({
  system: `You are a helpful agent`,
  tools: {
    discoverTool: instance.discoverTool,
  },
  prepareStep: instance.prepareStep,
});

/* ──────────────────────────────────────────────────────────
 * Session-scoped — full control
 *
 * dataset:   segments different agents/contexts (tool namespaces)
 * instance:  dataset + registered tools for this deploy
 * namespace: developer-defined segmentation (user, org, tenant...)
 * session:   current chat — tools, context, conversation
 *
 * namespace and session are independent scopes on instance.
 * Every tool can be scoped by namespace, session, or both.
 * ────────────────────────────────────────────────────────── */

import { Agent } from 'mastra';
import { Agentified } from '@agentified/mastra';

const ag = new Agentified();
await ag.connect();

const instance = await ag
  .dataset("agent-xyz")
  .registerTools({ tools: [/* ... */] });

// namespace: scopes user-level memories (preferences, history, etc.)
const userMemory = instance.namespace(userId);

// session: scopes current conversation (tools, messages, context)
const session = instance.session(chatId ?? uuid());

const agent = new Agent({
  system: `You are a helpful agent`,
  tools: {
    // session-scoped tool discovery
    discoverTool: session.discoverTool,
    // user-scoped memory tools (recall, preferences, etc.)
    ...userMemory.tools,
  },
  prepareStep: session.prepareStep,
});

/* ──────────────────────────────────────────────────────────
 * Conversation persistence — target interface sketch
 *
 * updateConversation() deduplicates and persists new messages.
 * getMessages() retrieves with a context strategy (recent, summary, etc.)
 * prepareStep handles assistant/tool messages from LLM steps.
 * ────────────────────────────────────────────────────────── */

// your backend endpoint
app.post('/chat', async (req) => {
  // 1. dedup + persist new messages (write)
  await session.updateConversation({ messages: req.body.messages });

  // 2. retrieve optimized context (read)
  const { messages } = await session.getMessages({
    strategy: 'recent+summary',
    maxTokens: 4000,
  });

  // 3. generate with optimized messages
  const response = await agent.generate(messages);
  return response;
});

// --- Agent-callable tools ---
// searchMessages — raw retrieval, like grep over history
//   searchMessages({ query: "pricing", limit: 10 })
//   → message chunks with timestamps, conversation ids
//
// recall — semantic retrieval, synthesized answer
//   recall({ topic: "user preferences", scope: "all_sessions" })
//   → summary, not raw messages. This is where memory starts.

// --- Power user: manual control via conversation handle ---
// For when you need explicit reads/writes outside the agent loop.
const conversation = session.conversation;

await conversation.append([
  { role: 'system', content: 'User upgraded to pro plan' },
]);

const context = await conversation.context({
  maxTokens: 4000,
  strategy: 'recent+summary', // 'recent' | 'summary' | 'recent+summary' | 'full'
});
// context.messages → CoreMessage[] ready for generate()

/* ──────────────────────────────────────────────────────────
 * Memory & Context Graph — internal data model
 *
 * Everything is a node. Edges are relationships.
 * Messages are ground truth; memories are derived artifacts
 * with provenance back to their source.
 *
 *   Session  ──has_many──▶  Message
 *   Message  ──extracted──▶  Memory
 *   Memory   ──about──────▶  Entity
 *   Entity   ──related_to──▶ Entity
 *   Memory   ──supersedes──▶ Memory  (versioning)
 *
 * Example traversal:
 *
 *   Message("I prefer dark mode")
 *     ↓ extracted_from
 *   Memory("user prefers dark mode")
 *     ↓ relates_to
 *   Entity("user-123")
 *     ↓ mentioned_in
 *   Message("set up my account with dark theme")
 *     ↓ part_of
 *   Session("user-123:onboarding")
 *
 * Why provenance matters:
 *   - Trust: agent can cite where a memory came from
 *   - Conflict resolution: new info supersedes old, linked to source
 *   - Decay/relevance: recency + frequency of linked sessions
 *   - Debugging: trace bad agent behavior back memory → message → session
 *
 * API impact:
 *   - recall() traverses the graph (Entity ← about ← Memory), not just text search
 *   - searchMessages() and recall() are two views of the same graph:
 *     messages = raw layer, memories = extracted layer, entities = structural layer
 *   - session() interface stays the same — the graph is mostly internal
 * ────────────────────────────────────────────────────────── */
