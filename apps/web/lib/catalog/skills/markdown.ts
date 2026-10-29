/** The fields a SKILL.md is assembled from. */
export interface SkillMarkdownFields {
  name: string;
  description: string;
  tags: string[];
  body: string;
}

/** Assemble a full SKILL.md (YAML frontmatter + body) for preview / copy. */
export function toSkillMarkdown(skill: SkillMarkdownFields): string {
  const tagsLine = skill.tags.length > 0 ? `tags: [${skill.tags.join(", ")}]\n` : "";
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n${tagsLine}---\n\n${skill.body}\n`;
}
