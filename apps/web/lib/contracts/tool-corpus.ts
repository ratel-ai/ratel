/** One tool of a project's catalog, as retrieval matches on it. */
export type CorpusEntry = {
  entryId: string;
  name: string;
  /** The searchable text retrieval reads, with any override applied. */
  searchable: string;
  /** What the agent is told the tool does. */
  description?: string;
  /** The searchable text the SDK sent, before any override. */
  runtimeSearchable?: string;
  /** "override" | "runtime" | "description": where `searchable` came from. */
  source: string;
  /** True when `searchable` is the agent description verbatim. */
  matchesAgentDescription: boolean;
  tags: string[];
};

/**
 * A project's tool catalog with each tool's searchable text resolved. Only the core reads the
 * runtime catalog and its description overrides, so it implements this and lends it to the
 * edition through `CompositionPorts.connect`; the Cloud edition's Tool Picker ranks it.
 */
export type ToolCorpusPort = {
  load(projectId: string): Promise<CorpusEntry[]>;
};
