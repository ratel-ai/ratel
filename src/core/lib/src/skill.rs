/// A skill registered for retrieval — the on-demand analog of a [`crate::Tool`].
///
/// `name`, `description`, and `tags` drive ranking (see [`crate::skill_indexing`]);
/// `body` is the payload returned on dispatch (the rendered `SKILL.md` contents)
/// and is deliberately *not* indexed, so a long body never skews relevance the
/// way a short, precise description should.
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub body: String,
}
