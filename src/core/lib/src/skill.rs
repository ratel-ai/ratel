use std::collections::HashMap;

/// A skill registered for retrieval — the on-demand analog of a [`crate::Tool`].
///
/// `name`, `description`, and `tags` drive ranking (see [`crate::skill_indexing`]).
/// `tags` are author-declared labels and task phrases ("frontend", "login form")
/// folded into the BM25 text so a terse intent prompt matches the skill. `tools`
/// are the ids of tools the body's instructions call — an explicit dependency
/// edge, **not** indexed; `search_capabilities` pulls them into its tools
/// bucket so the agent gets a skill and the tools it needs in one turn
/// instead of a second search. `metadata` is free-form, non-indexed context for
/// higher layers — e.g. `{"stacks": ["react"]}` for the push-path ranker to
/// boost/filter by project context, deliberately *not* matched as query terms.
/// `body` is the dispatch payload and is also not indexed, so a long body never
/// skews relevance.
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub tools: Vec<String>,
    pub metadata: HashMap<String, Vec<String>>,
    pub body: String,
}
