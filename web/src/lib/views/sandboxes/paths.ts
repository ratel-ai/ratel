/** The addresses of the Sandboxes pages. A sandbox name is `[a-z0-9-]`, so it needs no escape. */
export type SandboxSection = "playground" | "versions" | "secrets" | "configuration";

export function sandboxesHref(projectId: string): string {
  return `/project/${projectId}/sandboxes`;
}

/** The project secrets: on the Sandboxes list, below the table. */
export function projectSecretsHref(projectId: string): string {
  return `${sandboxesHref(projectId)}#project-secrets`;
}

/** One sandbox. The Playground is its first section, at the address of the sandbox. */
export function sandboxHref(
  projectId: string,
  name: string,
  section: SandboxSection = "playground",
): string {
  const root = `${sandboxesHref(projectId)}/${encodeURIComponent(name)}`;
  return section === "playground" ? root : `${root}/${section}`;
}
