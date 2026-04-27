use std::sync::Arc;

use agentified_lib::{
    models::{Skill as AgentifiedSkill, Tool as AgentifiedTool},
    AgentifiedCore,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, Content, ErrorData, GetPromptRequestParams,
        GetPromptResult, Implementation, ListPromptsResult, ListToolsResult,
        PaginatedRequestParams, Prompt, PromptMessage, PromptMessageContent, PromptMessageRole,
        ServerCapabilities, ServerInfo, Tool as McpTool,
    },
    service::{RequestContext, RoleServer},
    ServerHandler,
};

/// MCP server handler that exposes Agentified-registered tools and skills as MCP primitives.
///
/// `tools/list` returns all tools registered to the configured dataset (atoms).
/// `prompts/list` returns all skills registered to the configured dataset (molecules).
/// `prompts/get` returns the structured workflow for a skill (intent + atom sequence).
/// `tools/call` returns an error explaining that Agentified is a metadata layer; the
/// host application is responsible for executing tools.
pub struct AgentifiedMcpHandler {
    core: Arc<AgentifiedCore>,
    dataset_id: String,
}

impl AgentifiedMcpHandler {
    pub fn new(core: Arc<AgentifiedCore>, dataset_id: String) -> Self {
        Self { core, dataset_id }
    }
}

/// Convert an Agentified `Tool` to an MCP `Tool`. Used by `list_tools`.
fn to_mcp_tool(t: &AgentifiedTool) -> McpTool {
    let input_schema_obj: serde_json::Map<String, serde_json::Value> = match &t.parameters {
        serde_json::Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    McpTool::new(
        t.name.clone(),
        t.description.clone(),
        Arc::new(input_schema_obj),
    )
}

/// Convert an Agentified `Skill` to an MCP `Prompt`. Used by `prompts/list`.
fn to_mcp_prompt(s: &AgentifiedSkill) -> Prompt {
    Prompt::new(s.name.clone(), Some(s.description.clone()), None)
}

/// Render a skill as a structured prompt result. The user-role message describes
/// the intent and the assistant-role message lays out the suggested atom sequence
/// and edges so a downstream agent can execute the workflow.
fn skill_to_prompt_result(s: &AgentifiedSkill) -> GetPromptResult {
    let intent_text = if s.intent.trim().is_empty() {
        s.description.clone()
    } else {
        format!("{}\n\n{}", s.description, s.intent)
    };

    let mut plan = format!("Skill '{}' composes the following atoms:\n", s.name);
    for (i, atom) in s.atoms.iter().enumerate() {
        plan.push_str(&format!("  {}. {}\n", i + 1, atom));
    }
    if !s.edges.is_empty() {
        plan.push_str("\nGraph edges:\n");
        for edge in &s.edges {
            let source = match edge.source {
                agentified_lib::models::EdgeSource::Developer => "developer",
                agentified_lib::models::EdgeSource::Inspector => "inspector",
                agentified_lib::models::EdgeSource::Agentic => "agentic",
            };
            plan.push_str(&format!("  - {} -> {} ({})\n", edge.from, edge.to, source));
        }
    }
    plan.push_str("\nNote: Agentified exposes skill metadata only — the host agent decides whether and how to execute these atoms.");

    GetPromptResult::new(vec![
        PromptMessage::new(
            PromptMessageRole::User,
            PromptMessageContent::text(intent_text),
        ),
        PromptMessage::new(
            PromptMessageRole::Assistant,
            PromptMessageContent::text(plan),
        ),
    ])
}

impl ServerHandler for AgentifiedMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new("agentified", env!("CARGO_PKG_VERSION")))
        .with_instructions(
            "Agentified context intelligence MCP server. \
            Use tools/list to see the atoms (single-purpose tools) and \
            prompts/list to see the skills (molecules — composable workflows over atoms) \
            registered to this dataset.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let response = self
            .core
            .list_tools(&self.dataset_id)
            .await
            .map_err(|e| ErrorData::internal_error(format!("list_tools failed: {e}"), None))?;
        let tools: Vec<McpTool> = response.tools.iter().map(to_mcp_tool).collect();
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        Ok(CallToolResult::error(vec![Content::text(format!(
            "Tool '{}' was not executed by Agentified. \
            Agentified exposes tool metadata only — \
            the host application is responsible for executing tools.",
            request.name
        ))]))
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        let response = self
            .core
            .list_skills(&self.dataset_id)
            .await
            .map_err(|e| ErrorData::internal_error(format!("list_skills failed: {e}"), None))?;
        let prompts: Vec<Prompt> = response.skills.iter().map(to_mcp_prompt).collect();
        Ok(ListPromptsResult {
            prompts,
            next_cursor: None,
            meta: None,
        })
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResult, ErrorData> {
        let response = self
            .core
            .list_skills(&self.dataset_id)
            .await
            .map_err(|e| ErrorData::internal_error(format!("list_skills failed: {e}"), None))?;
        let skill = response
            .skills
            .into_iter()
            .find(|s| s.name == request.name)
            .ok_or_else(|| {
                ErrorData::invalid_params(format!("skill '{}' not found", request.name), None)
            })?;
        Ok(skill_to_prompt_result(&skill))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentified_lib::{
        models::{EdgeSource, RegisterToolsRequest, Skill, SkillEdge, Tool, ToolType},
        FakeEmbedding, NoopStorage,
    };

    fn build_core() -> Arc<AgentifiedCore> {
        Arc::new(AgentifiedCore::new(
            Arc::new(FakeEmbedding::new()),
            Arc::new(NoopStorage),
        ))
    }

    fn sample_tool() -> Tool {
        Tool {
            name: "getAccountInfo".into(),
            description: "Get customer account details".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string", "description": "Account identifier" }
                },
                "required": ["accountId"]
            }),
            metadata: None,
            fields: None,
            always_include: false,
            tool_type: ToolType::Backend,
            server_uri: None,
        }
    }

    #[test]
    fn to_mcp_tool_carries_name_description_and_schema() {
        let tool = sample_tool();
        let mcp = to_mcp_tool(&tool);

        assert_eq!(mcp.name.as_ref(), "getAccountInfo");
        assert_eq!(
            mcp.description.as_deref(),
            Some("Get customer account details")
        );
        assert_eq!(mcp.input_schema["type"], "object");
        assert_eq!(
            mcp.input_schema["properties"]["accountId"]["type"],
            "string"
        );
    }

    #[test]
    fn to_mcp_tool_handles_non_object_parameters_gracefully() {
        let mut tool = sample_tool();
        tool.parameters = serde_json::Value::Null;
        let mcp = to_mcp_tool(&tool);
        assert!(mcp.input_schema.is_empty());
    }

    #[tokio::test]
    async fn handler_lists_registered_tools() {
        let core = build_core();
        core.register_tools(
            "test-ds",
            RegisterToolsRequest {
                tools: vec![sample_tool()],
            }
            .tools,
        )
        .await
        .unwrap();

        let handler = AgentifiedMcpHandler::new(core, "test-ds".into());
        let result = handler.core.list_tools("test-ds").await.unwrap();
        assert_eq!(result.tools.len(), 1);
        assert_eq!(result.tools[0].name, "getAccountInfo");

        let mcp_tools: Vec<McpTool> = result.tools.iter().map(to_mcp_tool).collect();
        assert_eq!(mcp_tools.len(), 1);
        assert_eq!(mcp_tools[0].name.as_ref(), "getAccountInfo");
    }

    #[tokio::test]
    async fn handler_lists_empty_for_unknown_dataset() {
        let core = build_core();
        let handler = AgentifiedMcpHandler::new(core, "missing-ds".into());
        let result = handler.core.list_tools("missing-ds").await.unwrap();
        assert!(result.tools.is_empty());
    }

    #[test]
    fn server_info_declares_tools_and_prompts_capabilities() {
        let core = build_core();
        let handler = AgentifiedMcpHandler::new(core, "ds".into());
        let info = handler.get_info();
        assert!(info.capabilities.tools.is_some());
        assert!(info.capabilities.prompts.is_some());
        assert_eq!(info.server_info.name, "agentified");
    }

    fn sample_skill() -> Skill {
        Skill {
            name: "anomaly_memo".into(),
            description: "Investigate anomalous transactions and draft a memo".into(),
            intent: "User asks about suspicious activity".into(),
            atoms: vec!["getAccountInfo".into(), "processRefund".into()],
            edges: vec![SkillEdge {
                from: "getAccountInfo".into(),
                to: "processRefund".into(),
                source: EdgeSource::Developer,
            }],
            metadata: None,
        }
    }

    #[test]
    fn to_mcp_prompt_carries_name_and_description() {
        let skill = sample_skill();
        let prompt = to_mcp_prompt(&skill);
        assert_eq!(prompt.name, "anomaly_memo");
        assert_eq!(
            prompt.description.as_deref(),
            Some("Investigate anomalous transactions and draft a memo")
        );
    }

    #[test]
    fn skill_to_prompt_result_renders_intent_and_atom_sequence() {
        let skill = sample_skill();
        let result = skill_to_prompt_result(&skill);
        assert_eq!(result.messages.len(), 2);
        // user message: intent
        if let PromptMessageContent::Text { ref text } = result.messages[0].content {
            assert!(text.contains("Investigate anomalous transactions"));
            assert!(text.contains("User asks about suspicious activity"));
        } else {
            panic!("expected text content for user message");
        }
        // assistant message: plan
        if let PromptMessageContent::Text { ref text } = result.messages[1].content {
            assert!(text.contains("anomaly_memo"));
            assert!(text.contains("getAccountInfo"));
            assert!(text.contains("processRefund"));
            assert!(text.contains("getAccountInfo -> processRefund"));
            assert!(text.contains("(developer)"));
        } else {
            panic!("expected text content for assistant message");
        }
    }

    /// End-to-end: register tools + skills, then verify a real rmcp client
    /// can list them via `tools/list`, `prompts/list`, and fetch via `prompts/get`.
    #[tokio::test]
    async fn mcp_client_round_trips_skills() {
        use rmcp::{model::GetPromptRequestParams, ServiceExt};
        use tokio::io::duplex;

        let core = build_core();
        core.register_tools(
            "test-ds",
            vec![
                sample_tool(),
                Tool {
                    name: "processRefund".into(),
                    description: "Process a refund".into(),
                    parameters: serde_json::json!({"type": "object", "properties": {}}),
                    metadata: None,
                    fields: None,
                    always_include: false,
                    tool_type: ToolType::Backend,
                    server_uri: None,
                },
            ],
        )
        .await
        .unwrap();
        core.register_skills("test-ds", vec![sample_skill()])
            .await
            .unwrap();

        let (server_io, client_io) = duplex(8192);

        let handler = AgentifiedMcpHandler::new(core, "test-ds".into());
        let server_handle = tokio::spawn(async move {
            let service = handler.serve(server_io).await.unwrap();
            service.waiting().await.unwrap();
        });

        let client = ().serve(client_io).await.expect("client failed to initialize");

        let info = client.peer_info().expect("server info");
        assert!(info.capabilities.prompts.is_some());

        let prompts = client
            .list_prompts(Default::default())
            .await
            .expect("list_prompts succeeds");
        assert_eq!(prompts.prompts.len(), 1);
        assert_eq!(prompts.prompts[0].name, "anomaly_memo");

        let result = client
            .get_prompt(GetPromptRequestParams::new("anomaly_memo"))
            .await
            .expect("get_prompt succeeds");
        assert_eq!(result.messages.len(), 2);
        if let PromptMessageContent::Text { ref text } = result.messages[1].content {
            assert!(text.contains("getAccountInfo"));
            assert!(text.contains("processRefund"));
        } else {
            panic!("expected text content");
        }

        client.cancel().await.ok();
        server_handle.abort();
    }

    /// End-to-end: spin up the MCP server over an in-memory duplex stream,
    /// connect a real rmcp client, and verify it receives the registered tools
    /// via tools/list and the documented "host executes" error via tools/call.
    #[tokio::test]
    async fn mcp_client_round_trips_tools_list_and_call() {
        use rmcp::{model::CallToolRequestParams, ServiceExt};
        use tokio::io::duplex;

        let core = build_core();
        core.register_tools(
            "test-ds",
            vec![
                sample_tool(),
                Tool {
                    name: "processRefund".into(),
                    description: "Process a refund".into(),
                    parameters: serde_json::json!({"type": "object", "properties": {}}),
                    metadata: None,
                    fields: None,
                    always_include: false,
                    tool_type: ToolType::Backend,
                    server_uri: None,
                },
            ],
        )
        .await
        .unwrap();

        let (server_io, client_io) = duplex(8192);

        let handler = AgentifiedMcpHandler::new(core, "test-ds".into());
        let server_handle = tokio::spawn(async move {
            let service = handler.serve(server_io).await.unwrap();
            service.waiting().await.unwrap();
        });

        let client = ().serve(client_io).await.expect("client failed to initialize");

        let info = client.peer_info().expect("server info");
        assert_eq!(info.server_info.name, "agentified");
        assert!(info.capabilities.tools.is_some());

        let tools = client
            .list_tools(Default::default())
            .await
            .expect("list_tools succeeds");
        let names: Vec<&str> = tools.tools.iter().map(|t| t.name.as_ref()).collect();
        assert_eq!(tools.tools.len(), 2);
        assert!(names.contains(&"getAccountInfo"));
        assert!(names.contains(&"processRefund"));

        let call_result = client
            .call_tool(CallToolRequestParams::new("getAccountInfo"))
            .await
            .expect("call_tool returns a result");
        assert_eq!(call_result.is_error, Some(true));
        let text = call_result
            .content
            .first()
            .and_then(|c| c.as_text())
            .map(|t| t.text.clone())
            .unwrap_or_default();
        assert!(
            text.contains("not executed by Agentified"),
            "expected host-executes error message, got: {text}"
        );

        client.cancel().await.ok();
        server_handle.abort();
    }
}
