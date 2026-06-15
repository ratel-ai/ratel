use crate::indexing::push_identifier;
use crate::skill::Skill;

/// Flatten a skill into the text the BM25 index scores against.
///
/// Mirrors [`crate::indexing::searchable_text`] for tools: the name is pushed
/// both whole and identifier-split, then the description and each tag. The
/// `body` is intentionally excluded — it is the dispatch payload, not a ranking
/// signal (a 15 KB body would otherwise drown the description's term weights).
/// `stacks` and `tools` are likewise excluded: `stacks` bias the push ranker and
/// `tools` are a dependency edge surfaced at the gateway — neither is a query term.
pub(crate) fn searchable_text(skill: &Skill) -> String {
    let mut tokens: Vec<String> = Vec::new();
    if !skill.name.is_empty() {
        push_identifier(&skill.name, &mut tokens);
    }
    if !skill.description.is_empty() {
        tokens.push(skill.description.clone());
    }
    for tag in &skill.tags {
        if !tag.is_empty() {
            push_identifier(tag, &mut tokens);
        }
    }
    // Triggers are author-declared task phrases ("login form"), added to the
    // indexed text so a terse intent prompt ("add a login form") matches the
    // skill. Like all indexed text they are tokenized at index *and* query time
    // (lowercased, stemmed, stop-words removed) — not matched verbatim — so a
    // trigger made only of stop-words contributes no terms.
    for trigger in &skill.triggers {
        if !trigger.is_empty() {
            tokens.push(trigger.clone());
        }
    }
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slides_skill() -> Skill {
        Skill {
            id: "frontend-slides".into(),
            name: "frontend-slides".into(),
            description: "Build animation-rich HTML presentations".into(),
            tags: vec!["frontend".into(), "presentations".into()],
            triggers: vec!["slide deck".into()],
            stacks: vec!["react".into()],
            tools: vec!["fs__write_file".into()],
            body: "# Frontend Slides\n\nLong body that must not affect ranking…".into(),
        }
    }

    #[test]
    fn searchable_text_is_deterministic() {
        let skill = slides_skill();
        assert_eq!(searchable_text(&skill), searchable_text(&skill));
    }

    #[test]
    fn searchable_text_splits_hyphenated_name_for_word_matching() {
        let skill = slides_skill();
        let text = searchable_text(&skill);
        // Hyphens aren't identifier separators, so the whole name survives; the
        // description and tags supply the natural-language terms.
        assert!(
            text.contains("frontend-slides"),
            "whole name missing: {text}"
        );
        assert!(text.contains("presentations"), "tag missing: {text}");
    }

    #[test]
    fn searchable_text_excludes_body() {
        let skill = slides_skill();
        let text = searchable_text(&skill);
        assert!(
            !text.contains("must not affect ranking"),
            "body leaked into index: {text}"
        );
    }

    #[test]
    fn searchable_text_splits_snake_case_identifiers() {
        let skill = Skill {
            id: "code_review".into(),
            name: "code_review".into(),
            description: String::new(),
            tags: vec![],
            triggers: vec![],
            stacks: vec![],
            tools: vec![],
            body: String::new(),
        };
        let text = searchable_text(&skill);
        assert!(text.contains("code review"), "snake_case not split: {text}");
    }

    #[test]
    fn searchable_text_includes_triggers() {
        let skill = slides_skill();
        let text = searchable_text(&skill);
        assert!(
            text.contains("slide deck"),
            "trigger phrase missing: {text}"
        );
    }

    #[test]
    fn searchable_text_excludes_stacks() {
        // Stacks bias the push ranker by project context; they are not query terms.
        let skill = slides_skill();
        let text = searchable_text(&skill);
        assert!(!text.contains("react"), "stack leaked into index: {text}");
    }

    #[test]
    fn searchable_text_excludes_tools() {
        // Declared tool deps are surfaced at the gateway, not matched as terms.
        let skill = slides_skill();
        let text = searchable_text(&skill);
        assert!(
            !text.contains("write_file"),
            "tool dep leaked into index: {text}"
        );
    }
}
