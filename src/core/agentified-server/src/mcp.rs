use std::sync::Arc;

use agentified_lib::{models::Tool as AgentifiedTool, AgentifiedCore};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResult, Content, ErrorData, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool as McpTool,
    },
    service::{RequestContext, RoleServer},
    ServerHandler,
};

/// MCP server handler that exposes Agentified-registered tools as MCP primitives.
///
/// In Phase 1, `tools/list` returns all tools registered to the configured dataset.
/// `tools/call` returns an error explaining that Agentified is a metadata layer; the
/// host application is responsible for executing tools. Future phases will add
/// proxying for `Mcp`-typed tools and a `discover` meta-tool for two-stage selection.
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

impl ServerHandler for AgentifiedMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("agentified", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Agentified context intelligence MCP server. \
                Use tools/list to see the tools registered to this dataset.",
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
            In Phase 1, Agentified exposes tool metadata only — \
            the host application is responsible for executing tools.",
            request.name
        ))]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentified_lib::{
        models::{RegisterToolsRequest, Tool, ToolType},
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
    fn server_info_declares_tools_capability() {
        let core = build_core();
        let handler = AgentifiedMcpHandler::new(core, "ds".into());
        let info = handler.get_info();
        assert!(info.capabilities.tools.is_some());
        assert_eq!(info.server_info.name, "agentified");
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
