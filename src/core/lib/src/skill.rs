/// A skill registered for retrieval — the on-demand analog of a [`crate::Tool`].
///
/// `name`, `description`, `tags`, and `triggers` drive ranking (see
/// [`crate::skill_indexing`]). `triggers` are author-declared task phrases
/// ("dashboard", "login form") that bridge a terse intent prompt to the skill.
/// `stacks` (e.g. `["react", "next"]`) are deliberately **not** indexed — they
/// are carried for the push-path ranker to *boost/filter* by project context
/// rather than match as query terms. `tools` are the ids of tools the body's
/// instructions call — an explicit dependency edge, also **not** indexed; the
/// gateway pulls them into the `search_capabilities` tools bucket so the agent
/// gets a skill and the tools it needs in one turn instead of a second search.
/// `body` is the dispatch payload and is also not indexed, so a long body never
/// skews relevance.
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub triggers: Vec<String>,
    pub stacks: Vec<String>,
    pub tools: Vec<String>,
    pub body: String,
}
