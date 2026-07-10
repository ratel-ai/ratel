/// A tool registered for retrieval — one entry in a [`crate::ToolRegistry`]
/// corpus.
///
/// `name`, `description`, and the two schemas drive ranking: they are
/// flattened into the searchable text (identifiers are additionally
/// space-split so `read_file` also matches "read" and "file"; from the
/// schemas, property names, property descriptions, and enum values are
/// indexed — structural JSON keywords are not). `id` is the stable key hits
/// carry back and is not itself indexed.
pub struct Tool {
    /// Stable identifier, returned in [`crate::SearchHit::tool_id`].
    /// Registering the same id again replaces the entry in place. Not indexed
    /// for ranking.
    pub id: String,
    /// Model-facing tool name (e.g. `read_file`). Indexed both verbatim and
    /// space-split, so snake_case/camelCase constituent words match.
    pub name: String,
    /// What the tool does — the primary ranking text.
    pub description: String,
    /// JSON Schema of the tool's arguments. Property names, property
    /// descriptions, and enum values are folded into the searchable text.
    pub input_schema: serde_json::Value,
    /// JSON Schema of the tool's result, indexed the same way as
    /// [`Self::input_schema`].
    pub output_schema: serde_json::Value,
}
