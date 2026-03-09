# @agentified/mastra Client SDK — Implementation Spec (v1)

**Document type:** Implementation
**Status:** Draft — post-adversarial review (round 4: self-review)
**Scope:** New `Agentified` API for `@agentified/mastra`, Rust core refactor (library + server split, dataset/instance/namespace support), message/conversation persistence

---

## 1. Overview

Replace the current `AgentifiedMastra` class with a chainable `Agentified` API that introduces four scoping levels: **dataset**, **instance**, **namespace**, **session**. Add conversation persistence to the Rust core. Split the Rust core into a library crate and a server binary.

### Hierarchy

```
Agentified
  └── .dataset(name?) → DatasetRef
        └── .register({ tools, skills? }) → Instance  [async, creates new instance]
              ├── .discoverTool                       [instance-scoped]
              ├── .prepareStep                        [instance-scoped]
              ├── .namespace(id) → Namespace
              │     ├── .tools                        [namespace-scoped]
              │     ├── .discoverTool                 [namespace-scoped]
              │     └── .session(id) → Session
              │           ├── .discoverTool           [session-scoped]
              │           ├── .prepareStep            [session-scoped]
              │           ├── .updateConversation()   [async, dedup+persist]
              │           ├── .getMessages()          [async, read with strategy]
              │           ├── .conversation → Conversation
              │           └── .tools                  [session-scoped]
              └── .session(id) → Session              [default namespace]
```

**Shorthand:** `instance.session(id)` is sugar for `instance.namespace("default").session(id)`.

### Server-Side Hierarchy

The full scoping hierarchy on the server is: **dataset → instance → namespace → session**.

```
dataset "agent-xyz"
  ├── instance "abc123" (tools: [A, B, C])     ← deployed Monday
  ├── instance "def456" (tools: [A, B, D])     ← deployed Tuesday
  └── instance "ghi789" (tools: [A, D, E])     ← deployed Wednesday
```

Each `register()` call creates a **new instance** with a server-assigned `instance_id`. Prior instances remain alive as long as their client sends heartbeats. The core garbage-collects instances whose heartbeat has expired.

### Scoping Rules

| Scope | What it isolates | Server mechanism |
|-------|------------------|------------------|
| Dataset | Logical grouping of instances | `dataset_id` on all tables |
| Instance | Tool registrations, discovery index, agent-level learnings (Phase B) | `instance_id` on `tools`/`turns` tables; heartbeat + GC |
| Namespace | User/tenant-level memories, preferences (Phase B); message isolation | `namespace_id` on `messages` table; parameter on all endpoints |
| Session | Conversation messages, hydrated tools | `session_id` on `messages` table; cross-instance |

**Cross-boundary rules:**
- Tools registered in instance X are **not accessible** from instance Y, even within the same dataset.
- Namespaces and sessions are **cross-instance** — they work across all instances within a dataset. Tools are the only entity scoped to a specific instance.
- Session identity is the composite key `(dataset_id, namespace_id, session_id)` — **no instance_id**. This means the same session can be used with different instances (e.g., after a redeploy creates a new instance).
- `instance.session("s1")` and `instance.namespace("default").session("s1")` return handles to the **same** session.
- Messages and conversations are session-scoped (cross-instance). Tool discovery and turns are instance-scoped.

**Scoping for future context graph (Phase B):**

| Scope level | What will live here | Example |
|-------------|---------------------|---------|
| Instance | Agent-level learnings, procedural memories, skills | "Users usually ask about pricing before features" |
| Namespace | User/tenant-level memories, preferences | "This user prefers dark mode" |
| Session | Conversation-specific context | "We were discussing the billing API" |

The same tools are available at all scope levels — only the data they operate on (memories, messages) is scoped differently. Chat/conversation tools are session-scoped only.

### Session Lifecycle

Sessions are **lazy**. Calling `.session(id)` returns a handle without database side effects. The session is created on first write operation (`append()`, `prepareStep` persisting messages, or `captureTurn`). If the write fails, no session is created.

### Instance Lifecycle & Heartbeat

Each `register()` call:
1. Registers tools (and skills) on the core → core creates a new instance row, returns `instance_id`
2. Agentified starts a heartbeat interval (every 30s, `POST /api/v1/instances/{id}/heartbeat`)
3. Agentified stores `instance_id` on the returned Instance object

**Garbage collection:** The core runs a background task (every 60s) that deletes instances with `last_heartbeat < now - 5min` and their associated tools + embeddings. Messages and turns are **not** deleted (they belong to sessions, not instances). This means old sessions remain readable even after their originating instance is GC'd, but tool discovery for those sessions will no longer work.

**Disconnect:** `disconnect()` stops all heartbeats and optionally sends `DELETE /api/v1/instances/{id}` for immediate cleanup.

### register() Semantics

`register()` is async and **creates a new instance** on the core server. It does **not** replace or invalidate prior instances — multiple instances can coexist on the same dataset. Each call returns a fresh Instance bound to the newly registered tool set and skills.

**Tool type inference:** If a tool has a `handler` but no `type`, it defaults to `'backend'`. If a tool has no `handler` and no `type`, registration throws `AgentifiedError("Tool '{name}' has no type and no handler")`.

**Skill validation:** Every tool referenced in `skills[].tools` must exist in the `tools` array. Missing references throw `AgentifiedError("Skill '{skill}' references unknown tool: {name}")`.

**Internal flow (HTTP calls):**
1. `POST /api/v1/instances` → `{ instance_id }`
2. `POST /api/v1/instances/{id}/tools` → register tools (schema + type, handlers stay client-side)
3. If skills provided: `POST /api/v1/instances/{id}/skills` → register skills

If any step fails, the client calls `DELETE /api/v1/instances/{id}` to clean up the orphaned instance, then re-throws the original error.

### toolHandlers Constraint

**Tool handlers** (on `BackendTool`) execute **in the Agentified process only**. They are not serialized or sent to the core server. The core receives tool schemas (name, description, parameters, type) and skill definitions; tool execution happens client-side via handlers. MCP tools are proxied to their MCP server. Client tools are passed through to AG-UI as frontend tool calls.

---

## 2. Rust Core Refactor

### 2.1 Crate Split

Current structure:
```
src/core/
  src/main.rs      ← server binary + library code
  src/lib.rs       ← routes + state
```

Target structure:
```
src/core/
  Cargo.toml                ← workspace root: members = ["agentified-lib", "agentified-server"]
  agentified-lib/           ← library crate (agentified_core)
    Cargo.toml
    src/lib.rs              ← Core struct, public API
    src/models.rs
    src/embedding.rs
    src/ranking.rs
    src/storage.rs
    src/storage/sqlite.rs
    src/storage/noop.rs
  agentified-server/        ← binary crate
    Cargo.toml              ← depends on agentified-lib = { path = "../agentified-lib" }
    src/main.rs             ← axum routes, delegates to agentified_core
```

**agentified_core public API:**

```rust
pub struct AgentifiedCore {
    // owns storage, embedding service, in-memory indexes
}

impl AgentifiedCore {
    pub async fn new(config: CoreConfig) -> Result<Self>;

    // Instances
    pub async fn create_instance(&self, dataset: &str) -> Result<CreateInstanceResponse>;
    pub async fn heartbeat_instance(&self, instance_id: &str) -> Result<()>;
    pub async fn delete_instance(&self, instance_id: &str) -> Result<()>;
    pub async fn gc_instances(&self) -> Result<GcResult>;  // called by background task

    // Tools (scoped to instance)
    pub async fn register_tools(&self, instance_id: &str, tools: Vec<Tool>) -> Result<RegisterResponse>;
    pub async fn list_tools(&self, instance_id: &str) -> Result<Vec<Tool>>;
    pub async fn discover(&self, instance_id: &str, req: DiscoverRequest) -> Result<Vec<RankedTool>>;

    // Turns (scoped to instance + namespace + session)
    pub async fn capture_turn(&self, instance_id: &str, namespace: &str, session: &str, req: CaptureTurnRequest) -> Result<CaptureTurnResponse>;

    // Messages (scoped to dataset + namespace + session — survives instance GC)
    pub async fn append_messages(&self, dataset: &str, namespace: &str, session: &str, messages: Vec<Message>) -> Result<AppendMessagesResponse>;
    pub async fn get_messages(&self, dataset: &str, namespace: &str, session: &str, opts: GetMessagesOpts) -> Result<GetMessagesResponse>;
    pub async fn get_context(&self, dataset: &str, namespace: &str, session: &str, opts: ContextOpts) -> Result<ContextResponse>;
}
```

### 2.2 Storage Schema

**Storage changes (SQLite):**

```sql
-- instances table (NEW)
CREATE TABLE instances (
    instance_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    created_at TEXT NOT NULL,         -- ISO 8601
    last_heartbeat TEXT NOT NULL      -- ISO 8601, updated by heartbeat endpoint
);
CREATE INDEX idx_instances_dataset ON instances(dataset_id);
CREATE INDEX idx_instances_heartbeat ON instances(last_heartbeat);

-- tools table gains instance_id (replaces dataset_id for tool scoping)
ALTER TABLE tools ADD COLUMN instance_id TEXT NOT NULL;
CREATE INDEX idx_tools_instance ON tools(instance_id);

-- messages table (NEW)
-- Messages are scoped to (dataset_id, namespace_id, session_id) — NOT to instance.
-- This means messages survive instance GC and can be read by future instances.
-- seq is auto-assigned by the server: MAX(seq)+1 within the (dataset, namespace, session).
-- Concurrent appends are serialized via BEGIN IMMEDIATE (SQLite single-writer lock).
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL DEFAULT 'default',
    namespace_id TEXT NOT NULL DEFAULT 'default',
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system' | 'tool'
    content TEXT NOT NULL,
    tool_call_id TEXT,
    tool_calls TEXT,              -- JSON array, nullable
    created_at TEXT NOT NULL,     -- ISO 8601
    seq INTEGER NOT NULL          -- server-assigned, monotonic per (dataset_id, namespace_id, session_id)
);
CREATE INDEX idx_messages_session ON messages(dataset_id, namespace_id, session_id, seq);

-- turns table gains instance_id + namespace_id + session_id
ALTER TABLE turns ADD COLUMN instance_id TEXT NOT NULL;
ALTER TABLE turns ADD COLUMN namespace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE turns ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default';
```

### 2.3 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/v1/instances` | POST | Create instance, returns `{ instance_id }` |
| `POST /api/v1/instances/{id}/heartbeat` | POST | Update last_heartbeat |
| `DELETE /api/v1/instances/{id}` | DELETE | Immediate instance cleanup |
| `POST /api/v1/instances/{id}/tools` | POST | Register tools for instance |
| `GET /api/v1/instances/{id}/tools` | GET | List tools for instance |
| `POST /api/v1/instances/{id}/discover` | POST | Discover tools scoped to instance |
| `POST /api/v1/instances/{id}/turns` | POST | Capture turn (+ namespace, session in body) |
| `POST /api/v1/messages` | POST | Append messages (dataset, namespace, session in body) |
| `GET /api/v1/messages` | GET | Get messages (dataset, namespace, session as query params) |
| `POST /api/v1/context` | POST | Get optimized context (dataset, namespace, session in body) |
| `GET /health` | GET | Health check: `{ "status": "ok" }` |

### 2.4 Instance Endpoints

**POST /api/v1/instances**

```json
{ "dataset": "agent-xyz" }
```

Response: `{ "instance_id": "abc123" }`

**POST /api/v1/instances/{id}/heartbeat**

No body. Response: `204 No Content`.

**DELETE /api/v1/instances/{id}**

No body. Response: `204 No Content`. Non-existent instance → `404`.

### 2.5 Message Persistence Endpoints

**POST /api/v1/messages**

```json
{
  "dataset": "agent-xyz",
  "namespace": "user-123",
  "session": "session-abc",
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!" }
  ]
}
```

Response: `{ "appended": 2, "first_seq": 42, "last_seq": 43 }`

**GET /api/v1/messages?dataset=agent-xyz&namespace=user-123&session=session-abc&limit=50&after_seq=0**

Messages are **always returned oldest→newest** (ascending seq). `limit` controls the max number returned. Pagination modes:

- `after_seq=N` — return messages with `seq > N` (paginate forward from known position)
- `around_seq=N` — return a window of `limit` messages centered on seq N (floor(limit/2) before, ceil(limit/2) after). Used by agent's `getMessages` tool for viewing adjacent conversation context.
- Neither — return the **last `limit` messages** (most recent, ascending order)

`limit=0` returns no messages but still includes `max_seq` in the response (used for seq discovery). `after_seq` and `around_seq` are mutually exclusive; providing both returns 400.

Response:
```json
{
  "messages": [
    { "id": "...", "role": "user", "content": "Hello", "seq": 1, "created_at": "..." }
  ],
  "has_more": false,
  "max_seq": 142
}
```

**POST /api/v1/context**

> **Note:** The context endpoint request/response is extended by [context-layer-spec.md §7](./context-layer-spec.md) to support recalled primitives (tools, memories, knowledge, artifacts) alongside messages. The extended response supersedes the one below — it adds a `recalled` object and `token_estimate` while preserving all fields shown here.

```json
{
  "dataset": "agent-xyz",
  "namespace": "user-123",
  "session": "session-abc",
  "max_tokens": 4000,
  "strategy": "recent+summary"
}
```

Response (base — see context-layer-spec for extended version):
```json
{
  "messages": [...],
  "strategy_used": "recent+summary",
  "total_messages": 142,
  "included_messages": 28,
  "summary": "User is building an e-commerce app...",
  "fallback": false
}
```

### 2.6 Context Strategies

| Strategy | Behavior | Requires LLM |
|----------|----------|--------------|
| `full` | Return all messages (up to max_tokens) | No |
| `recent` | Return N most recent messages fitting in max_tokens | No |
| `summary` | Return LLM-generated summary only | Yes |
| `recent+summary` | Summary of older messages + recent messages verbatim | Yes |

**Defaults:** strategy = `recent`, max_tokens = `4000`.

**Token counting:** Character/4 heuristic for v1. The `included_messages` count in the response lets the client verify and adjust. A future version may accept a `tokenizer` parameter.

**LLM integration:** `summary` and `recent+summary` use the same OpenAI key configured for embeddings. The **full summary text** is cached per session, cache key: `(dataset_id, namespace_id, session_id, max_seq)` where `max_seq` is the highest seq at generation time. Invalidated when new messages arrive (higher seq). The `max_tokens` parameter controls how the cached summary is truncated/included in the response — it does not affect cache identity.

**Fallback chain:** If the LLM call fails (timeout, API error, invalid response) after 2 retries over 15s total, the server falls back to `recent` strategy. Response includes `"fallback": true` and `"strategy_used": "recent"`. If `recent` also fails (DB error), return 503.

**OPENAI_API_KEY validation:** If a `summary` or `recent+summary` request arrives and `OPENAI_API_KEY` is not configured, the core returns 422 with `{ "error": "OPENAI_API_KEY required for summary strategy" }`.

---

## 3. TypeScript SDK — @agentified/sdk Changes

The low-level SDK gains instance/namespace/session awareness:

```typescript
export interface ApiClientConfig {
  serverUrl: string;
  tools: ServerTool[];
  dataset?: string;        // default: "default"
  onEvent?: (event: AgentifiedEvent) => void;
}

class ApiClient {
  // Instance lifecycle
  async createInstance(dataset: string): Promise<{ instanceId: string }>;
  async heartbeatInstance(instanceId: string): Promise<void>;
  async deleteInstance(instanceId: string): Promise<void>;

  // Tools (scoped to instance)
  async register(instanceId: string): Promise<RegisterResponse>;
  async discover(instanceId: string, query: string, limit?: number, exclude?: string[], turnId?: string): Promise<RankedTool[]>;

  // Turns
  async captureTurn(instanceId: string, namespace: string, session: string, opts: CaptureTurnOptions): Promise<CaptureTurnResponse>;

  // Messages (scoped to dataset + namespace + session)
  async appendMessages(dataset: string, namespace: string, session: string, messages: Message[]): Promise<AppendMessagesResponse>;
  async getMessages(dataset: string, namespace: string, session: string, opts?: GetMessagesOpts): Promise<GetMessagesResponse>;
  async getContext(dataset: string, namespace: string, session: string, opts?: ContextOpts): Promise<ContextResponse>;

  // Existing
  asDiscoverTool(instanceId: string): DiscoverTool;
  prefetch(instanceId: string, options: PrefetchOptions): Promise<RankedTool[]>;
}
```

---

## 4. TypeScript SDK — @agentified/mastra New API

### 4.1 Types

```typescript
export interface AgentifiedConfig {
  serverUrl?: string;   // if omitted, auto-spawn local core
  apiKey?: string;      // for managed cloud (future)
}

// --- Unified Tool Model ---

type AgentifiedTool = BackendTool | ClientTool | McpTool;

interface BackendTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  type?: 'backend';  // default when handler present
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ClientTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  type: 'client';  // required — no handler, executed by frontend via AG-UI
}

interface McpTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  type: 'mcp';
  server: string;  // MCP server URI
}

interface SkillDef {
  name: string;                    // 1-64 chars, lowercase + hyphens (agentskills.io)
  description: string;             // what the skill does and when to use it
  instructions: string;            // SKILL.md body — procedural knowledge, markdown
  tools: string[];                 // tool names this skill references
  allowedTools?: string[];         // pre-approved tools (agentskills.io experimental)
  metadata?: Record<string, string>;
}

/** Helper: create McpTool[] from an MCP server config */
function mcpTools(config: {
  server: string;
  tools: Array<{ name: string; description: string; parameters: JSONSchema }>;
}): McpTool[];

export interface RegisterInput {
  tools: AgentifiedTool[];
  skills?: SkillDef[];
}

// Type inference: no type + handler present → 'backend'. No type + no handler → error.

export interface UpdateConversationInput {
  messages: Array<{ role: string; content: string }>;
}

export interface GetMessagesOptions {
  maxMessages?: number;     // default: no limit (return all that fit strategy)
  maxTokens?: number;       // default: 4000
  strategy?: 'full' | 'recent' | 'summary' | 'recent+summary';  // default: 'recent'
}

export interface GetMessagesResult {
  messages: Array<{ role: string; content: string }>;
  summary?: string;
  fallback?: boolean;
  totalMessages: number;
  includedMessages: number;
}
```

### 4.2 Agentified

```typescript
export class Agentified {
  constructor();

  /**
   * Connect to agentified core.
   * - No args: spawn local core process, connect to it
   * - With URL: connect to remote server
   *
   * For local spawn: inherits process.env. Throws AgentifiedError if
   * OPENAI_API_KEY is not set in environment.
   */
  async connect(serverUrl?: string): Promise<void>;

  /** Scope to a dataset. Returns a chainable DatasetRef. */
  dataset(name: string): DatasetRef;

  /** Register on default dataset. Shorthand for dataset("default").register(...) */
  async register(input: RegisterInput): Promise<Instance>;

  /** Graceful shutdown: stops heartbeats, deletes instances, stops local core if spawned */
  async disconnect(): Promise<void>;
}
```

### 4.3 DatasetRef

```typescript
export class DatasetRef {
  constructor(agentified: Agentified, datasetName: string);

  async register(input: RegisterInput): Promise<Instance>;
}
```

Thin object — exists only to chain `.dataset("x").register(...)`.

### 4.4 Instance

The result of registering tools on a dataset. Holds a server-assigned `instanceId` and runs a heartbeat interval. Provides instance-scoped tools and factory methods for namespace/session.

```typescript
export class Instance {
  readonly instanceId: string;
  readonly datasetId: string;

  /** Instance-scoped discover tool — searches this instance's registered tools */
  readonly discoverTool: MastraTool;

  /** Instance-scoped prepareStep — tool hydration only, no message persistence */
  readonly prepareStep: PrepareStepFn;

  /** Create a namespace scope */
  namespace(id: string): Namespace;

  /** Create a session scope on the default namespace */
  session(id: string): Session;
}
```

### 4.5 Namespace

```typescript
export class Namespace {
  readonly id: string;

  /**
   * Namespace-scoped tools.
   * For v1: contains discoverTool (same tool set as instance, but discover
   * queries will include namespace context in Phase B when memories exist).
   * Phase B adds: recall, preferences.
   */
  readonly tools: Record<string, MastraTool>;

  /** Namespace-scoped discover — delegates to instance discover for v1 */
  readonly discoverTool: MastraTool;

  /** Create a session within this namespace */
  session(id: string): Session;
}
```

### 4.6 Session

```typescript
export class Session {
  readonly id: string;
  readonly namespaceId: string;

  /** Session-scoped discover tool */
  readonly discoverTool: MastraTool;

  /**
   * Session-scoped prepareStep (readonly property).
   * Handles tool hydration from discover results in prior steps.
   * Persists assistant/tool messages from LLM steps (NOT user input — that's updateConversation's job).
   */
  readonly prepareStep: PrepareStepFn;

  /** Session-scoped tools (future: searchMessages, recall scoped to session) */
  readonly tools: Record<string, MastraTool>;

  /**
   * Deduplicates incoming messages against stored history and persists the delta.
   * This is a WRITE operation — it does not return messages.
   *
   * Dedup: compares incoming messages against the tail of stored history by
   * role + content. Only genuinely new messages are appended.
   */
  async updateConversation(input: UpdateConversationInput): Promise<void>;

  /**
   * Superseded by context builder — see context-layer-spec.md §5.
   * Preferred usage:
   *   await session.updateConversation({ messages: req.body.messages });
   *   const { messages } = await session.context
   *     .messages({ strategy: 'recent+summary', maxTokens: 4000 })
   *     .recall()
   *     .assemble();
   *   const response = await agent.generate(messages, { prepareStep: session.prepareStep });
   *
   * getMessages() remains as a convenience for messages-only retrieval (no recall).
   */
  async getMessages(opts?: GetMessagesOptions): Promise<GetMessagesResult>;

  /** Manual conversation control (low-level append, raw history) */
  readonly conversation: Conversation;
}
```

### 4.7 Conversation

```typescript
export class Conversation {
  /** Append messages directly (no dedup). Returns seq range for tracking. */
  async append(messages: Array<{ role: string; content: string }>): Promise<{ appended: number; firstSeq: number; lastSeq: number }>;

  /** Get raw message history (no strategy applied, just stored messages) */
  async messages(opts?: { limit?: number; afterSeq?: number }): Promise<Array<StoredMessage>>;
}
```

### 4.8 PrepareStepFn Behavior

```typescript
type PrepareStepFn = (params: {
  stepNumber: number;
  steps: any[];
}) => Promise<{ activeTools: string[] }>;
```

**PrepareStep is NOT user-provided.** It is a built-in function created by Session/Instance. The developer passes it to Mastra's agent config as-is.

**Instance.prepareStep (instance-scoped, readonly property):**
- Initial activeTools = all registered tool names (from `tools` passed to `register()`) + `"agentified_discover"`
- Scans prior steps for discover tool results → adds discovered tool names to activeTools set
- No message persistence
- Set once on Agent construction: `prepareStep: instance.prepareStep`

**Session.prepareStep (session-scoped, readonly property):**

Initial activeTools = all registered tool names (from `tools` passed to `register()`) + `"agentified_discover"`.

On each step:
1. Extract assistant/tool messages from `steps` array. Mapping: `step.toolCalls` → assistant messages with tool_calls field; `step.toolResults` → tool role messages; `step.text` → assistant content.
2. Persist new messages via `POST /api/v1/messages` (core assigns seq values)
3. Update `lastPersistedSeq` from response's `last_seq` field
4. Scan prior steps for discover tool results → add discovered tool names to activeTools set
5. Return `{ activeTools: [...activeToolsSet] }`

**Note:** User/system messages are persisted by `updateConversation()`, not by prepareStep. PrepareStep only handles LLM-generated content (assistant responses, tool calls/results).

### 4.8.1 updateConversation Behavior

`session.updateConversation({ messages })` — **write-only**, dedup + persist:

1. Fetch the last N stored messages (where N = `messages.length`) via `GET /api/v1/messages?limit={N}`. This returns both the tail to compare against and `max_seq` in the response.
2. Diff incoming `messages` against the fetched tail — compare by role + content from the end. Only genuinely new messages (not matched in the tail) are considered new.
3. Persist new messages via `POST /api/v1/messages` (user input, system prompts, any new messages)
4. Update `lastPersistedSeq` from response's `last_seq`

If no new messages (all duplicates), skip the append call.

### 4.8.2 getMessages Behavior

`session.getMessages({ maxMessages?, maxTokens?, strategy? })` — **read-only**, retrieve with strategy:

1. Call `POST /api/v1/context` with the session's `(dataset, namespace, session)` scope and the specified strategy (default: `recent`), maxTokens (default: 4000)
2. If `maxMessages` is specified, truncate from oldest to fit
3. Return `GetMessagesResult` with messages array + metadata

**Separation of concerns:** `updateConversation` handles persistence (write). `getMessages` handles retrieval + optimization (read). They are independent — you can call `getMessages` without `updateConversation` (e.g., to read an existing session), or `updateConversation` without `getMessages` (e.g., fire-and-forget persistence).

**Seq tracking:** If a gap is detected (seq not monotonic in returned messages), log a warning but do not fail.

### 4.9 ContextResult.tools Hydration

`tools` in ContextResult is derived from the most recent turn's `tools_loaded` list for this session **scoped to the current instance** (from the `turns` table, filtered by `instance_id`). Each tool name is looked up in the Instance's `toolHandlers`. Tools not found in current handlers are silently skipped (they may have been removed between deploys). If no prior turn exists for the current instance, `tools` is empty — this is expected after a redeploy creates a new instance. Turns from GC'd instances are ignored.

### 4.10 Local Core Auto-Spawn

When `connect()` is called without a URL:

0. **Pre-check:** If `OPENAI_API_KEY` is not in `process.env`, throw `AgentifiedError("OPENAI_API_KEY environment variable is required")`.
1. Resolve binary path: `@agentified/core-{platform}-{arch}` npm package. Use `createRequire(import.meta.url).resolve(...)` for ESM compatibility.
2. Find available port: probe from Node.js — create a `net.Server`, bind to port 0 to get an OS-assigned free port, close the server, use that port. Fallback: try 9119, if `net.connect` succeeds (port already in use), increment. Max 10 attempts.
3. Spawn child process: `agentified-core --port {port}` with `stdio: ['ignore', 'pipe', 'pipe']`. Child inherits `process.env`.
4. Health check: `GET /health` expecting `{ "status": "ok" }` with HTTP 200. Retry every 200ms, max 25 attempts (5s total). If all fail, kill spawned process and throw `AgentifiedError("Core failed to start within 5s")`.
5. Configure internal SDK with `serverUrl = http://127.0.0.1:{port}`
6. Register cleanup: on `SIGINT`, `SIGTERM`, `beforeExit`, and `process.on('exit')`, send `SIGTERM` to child then `SIGKILL` after 2s grace period.
7. **Crash detection:** Listen for child process `exit` event. If unexpected (not triggered by `disconnect()`), attempt one auto-restart (steps 1-5). If restart also fails, throw `AgentifiedError("Core crashed and restart failed")`. Do not attempt restart again within 60s of a previous restart.

Platform packages (published separately):
- `@agentified/core-darwin-arm64`
- `@agentified/core-darwin-x64`
- `@agentified/core-linux-x64`
- `@agentified/core-linux-arm64`
- `@agentified/core-win32-x64`

Each contains a single prebuilt binary. `@agentified/mastra` has optional peer deps on these.

---

## 5. Migration Path

`AgentifiedMastra` remains exported but deprecated. New code uses `Agentified`. The internal implementation of `AgentifiedMastra` can be refactored to use `Agentified` under the hood once stable.

---

## 6. Anti-Patterns (DO NOT)

| Don't | Do Instead | Why |
|-------|-----------|-----|
| Replace tools on register | Create a new instance per register() call | Multiple deploys can coexist; old sessions keep working |
| Store messages client-side | Always persist via core server | Single source of truth |
| Auto-create sessions on Instance construction | Sessions are created lazily on first write | Developer controls lifecycle |
| Make namespace mandatory | Default to `"default"` namespace | Lower friction for simple use cases |
| Bundle all platform binaries in one package | Separate `@agentified/core-{platform}` packages | 50MB+ binary per platform, npm install bloat |
| Keep dataset/instance state in TypeScript | Dataset/instance are core server concepts, TS is a thin client | Enables multi-client, multi-language |
| Block on `connect()` indefinitely | 5s timeout on health check, throw if core won't start | Developer gets clear error |
| Use `__setTools` monkey-patching from AgentifiedMastra | Use Mastra's `prepareStep` + `activeTools` API | Clean, supported integration point |
| Delete messages on instance GC | Messages belong to sessions, not instances | Old conversations remain readable |
| Skip OPENAI_API_KEY check before spawn | Validate env before spawning core process | Clear error vs cryptic Rust panic |

---

## 7. Test Case Specifications

### Unit Tests — @agentified/mastra

| Test ID | Component | Input | Expected Output | Edge Cases |
|---------|-----------|-------|-----------------|------------|
| TC-001 | Agentified.connect() | No args | Spawns local process, resolves when healthy | Port already in use → picks next port |
| TC-002 | Agentified.connect(url) | Remote URL | Connects, health check passes | Unreachable URL → throws after timeout |
| TC-003 | Agentified.dataset().register() | Tools + skills | Returns Instance with instanceId + searchTools | Empty tools array → Instance with searchTools only |
| TC-004 | Agentified.register() | Tools (no dataset) | Uses default dataset | Same as TC-003 behavior |
| TC-005 | Instance.session(id) | Session ID | Returns Session with default namespace | |
| TC-006 | Instance.namespace(id).session(id) | Both IDs | Returns Session with explicit namespace | |
| TC-007 | Session.prepareStep | Steps with discover results | Returns expanded activeTools | No discover results → returns initial tools |
| TC-008 | Session.prepareStep | Steps with assistant/tool messages | Persists LLM-generated messages, updates lastPersistedSeq | No new messages → no-op |
| TC-009 | Session.updateConversation() | Raw messages array | Deduplicates, persists only new messages | Empty session → persists all |
| TC-009b | Session.updateConversation() | Same messages twice | Second call is no-op (all duplicates) | No append call made |
| TC-009c | Session.getMessages() | strategy='recent', maxTokens=2000 | Returns recent messages fitting token budget | Empty session → empty messages |
| TC-010 | Conversation.append() | Array of messages | Returns `{ appended, firstSeq, lastSeq }` | Empty array → `{ appended: 0, firstSeq: 0, lastSeq: 0 }` |
| TC-011 | Conversation.messages() | limit=10 | Returns last 10 messages | No messages → empty array |
| TC-012 | Agentified.disconnect() | After connect() | Stops heartbeats, deletes instances, stops core | Already disconnected → no-op |
| TC-013 | Instance heartbeat | 30s interval | Heartbeat sent to core | Core unreachable → log warning, continue |
| TC-014 | register() twice | Same dataset | Two separate instances with different instanceIds | Both discoverable independently |
| TC-015 | BackendTool missing handler | Tool with no type and no handler | Throws AgentifiedError | |
| TC-016 | Skill references unknown tool | Skill lists tool not in tools array | Throws AgentifiedError | |

### Unit Tests — Rust Core

| Test ID | Component | Input | Expected Output | Edge Cases |
|---------|-----------|-------|-----------------|------------|
| TC-R01 | create_instance | dataset="a" | Returns instance_id | |
| TC-R02 | register_tools | instance_id, tools=[...] | Tools stored under that instance | Same tool name, different instance → separate entries |
| TC-R03 | discover | instance_id, query | Only returns tools from that instance | Query matches tools in other instance → excluded |
| TC-R04 | append_messages | dataset+ns+session, messages | Messages stored with incrementing seq | Concurrent appends → seq is atomic |
| TC-R05 | append_messages response | 3 messages appended | `{ appended: 3, first_seq: N, last_seq: N+2 }` | |
| TC-R06 | get_messages | session with msgs, limit=5 (no after_seq) | Returns 5 most recent (ascending) | Session doesn't exist → empty array, max_seq=0 |
| TC-R07 | get_context (recent) | 100 msgs, max_tokens=2000 | Returns recent msgs fitting in budget (char/4) | |
| TC-R08 | get_context (full) | 10 msgs | Returns all messages | Exceeds max_tokens → truncates from oldest |
| TC-R09 | get_context (summary, no key) | No OPENAI_API_KEY | Returns 422 with clear error message | |
| TC-R10 | instance GC | Instance with expired heartbeat | Instance + tools deleted; messages preserved | |
| TC-R11 | heartbeat | Valid instance_id | last_heartbeat updated | Non-existent instance → 404 |
| TC-R12 | instance isolation | Register in inst-A, discover in inst-B | No cross-instance results | |

### Integration Tests

| Test ID | Flow | Setup | Verification | Teardown |
|---------|------|-------|--------------|----------|
| IT-001 | Full client lifecycle | `connect → register → session → context → disconnect` | All steps complete, messages persisted | Core stopped |
| IT-002 | Instance isolation | Two register() on same dataset | Discover in each returns only its own tools | |
| IT-003 | Session message persistence | `updateConversation({ messages })` then `generate()` with prepareStep | `conversation.messages()` returns user input (from updateConversation) + LLM output (from prepareStep) with correct seq | |
| IT-004 | Multi-session | Two sessions on same instance | Each has independent message history | |
| IT-005 | Remote connect | Start core manually, connect(url) | All operations work | Stop core |
| IT-006 | Instance GC | Register, stop heartbeat, wait >5min | Instance tools gone, messages still readable | |
| IT-007 | Namespace isolation | Two namespaces, same session ID | Different message histories | |
| IT-008 | Cross-instance session | Register inst-A, write msgs to session S1, GC inst-A, register inst-B, read session S1 via inst-B | Messages readable, tools empty (no turns on inst-B) | |

---

## 8. Error Handling Matrix

| Error Type | Detection | Response | Fallback | Logging |
|------------|-----------|----------|----------|---------|
| Core binary not found | `spawn` throws ENOENT | Throw `AgentifiedError("Core binary not found. Install @agentified/core-{platform}-{arch}")` | None | ERROR |
| OPENAI_API_KEY missing (spawn) | Pre-check before spawn | Throw `AgentifiedError("OPENAI_API_KEY environment variable is required")` | None | ERROR |
| Core won't start (port busy) | Node.js port probe detects in-use | Try next port (max 10 attempts) | Throw after 10 attempts | WARN per retry |
| Core health check timeout | 5s elapsed, no 200 | Throw `AgentifiedError("Core failed to start within 5s")` | None | ERROR |
| Remote server unreachable | fetch throws | Throw `AgentifiedError("Cannot connect to {url}")` | None | ERROR |
| Tool with no type and no handler | Type inference fails | Throw `AgentifiedError("Tool '{name}' has no type and no handler")` | None | ERROR |
| Skill references unknown tool | Tool name not in tools array | Throw `AgentifiedError("Skill '{skill}' references unknown tool: {name}")` | None | ERROR |
| Message append fails | Non-2xx from core | Throw, do not silently drop | None | ERROR |
| Context generation fails (LLM) | Core returns 500 on summary/recent+summary | Core auto-falls back to `recent` (response: `"fallback": true`) | If DB also fails → 503 | WARN |
| Context with no OPENAI_API_KEY | Core returns 422 on summary strategies | Throw `AgentifiedError("OPENAI_API_KEY required for summary strategy")` | None | ERROR |
| Session not found on context() | Core returns empty messages | Return empty ContextResult | None | DEBUG |
| Discover returns 0 tools | Empty array from core | Return empty array (not an error) | None | DEBUG |
| Heartbeat fails | Non-2xx from core | Log warning, retry next interval | If 5 consecutive failures → log error | WARN |
| Core process crashes | Child `exit` event (unexpected) | Auto-restart once (60s cooldown) | Throw if restart fails | ERROR + WARN |
| Instance GC'd while in use | 404 on discover/tools endpoints | Throw `AgentifiedError("Instance expired. Call register() again.")` | None | ERROR |

---

## 9. References

| Topic | Location |
|-------|----------|
| Interface sketch | [example.ts](../../example.ts) |
| Current mastra adapter | [src/ts-packages/mastra/src/adapter.ts](../../src/ts-packages/mastra/src/adapter.ts) |
| Current SDK | [src/ts-packages/sdk/src/agentified.ts](../../src/ts-packages/sdk/src/agentified.ts) |
| SDK types | [src/ts-packages/sdk/src/types.ts](../../src/ts-packages/sdk/src/types.ts) |
| Rust core lib | [src/core/src/lib.rs](../../src/core/src/lib.rs) |
| Rust core models | [src/core/src/models.rs](../../src/core/src/models.rs) |
| Context layer architecture | [context-layer-spec.md](./context-layer-spec.md) |
| Cognee research | Conversation context (not persisted) |
