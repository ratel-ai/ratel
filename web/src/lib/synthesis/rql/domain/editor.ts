import { RQL_FUNCTIONS, RQL_TABLES, type RqlTableName, type RqlType } from "./catalog";
import { describeRqlSchema } from "./describe";

/**
 * What the RQL field of the console offers as a person writes: the tables, the columns of the
 * table in FROM, the functions with their signatures, the keywords and the operators. It reads the
 * same catalog as the compiler and `describe_rql_schema`, so it offers nothing the compiler
 * refuses. The project's trace properties are an input, not part of the catalog: inside
 * `properties['` it offers them, a detected one off. Pure and safe for the browser.
 */

/** The trace properties of the project, as the page read them. */
export interface RqlEditorProperties {
  indexed: readonly string[];
  detected: readonly string[];
}

export interface RqlEditorData {
  tables: {
    name: RqlTableName;
    description: string;
    columns: { name: string; type: RqlType; description: string }[];
  }[];
  functions: { name: string; signature: string; returns: string; description: string }[];
  keywords: readonly string[];
  operators: string[];
  properties: { indexed: string[]; detected: string[] };
}

/** One completion of the field. `type` names its icon: a table, a column, a function, a word. */
export interface RqlCompletion {
  label: string;
  type: "class" | "property" | "function" | "keyword" | "operator";
  detail?: string;
  info?: string;
  /** Shown, and not written when picked: a property that is not indexed. */
  disabled?: true;
}

/** The keywords of a SELECT that RQL accepts, in the order a query reads them. */
export const RQL_KEYWORDS = [
  "select",
  "distinct",
  "as",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "between",
  "like",
  "ilike",
  "is",
  "null",
  "true",
  "false",
  "group by",
  "having",
  "order by",
  "asc",
  "desc",
  "nulls first",
  "nulls last",
  "limit",
] as const;

/** The editor data of the catalog and of the project's properties. Pure. */
export function rqlEditorData(
  properties: RqlEditorProperties = { indexed: [], detected: [] },
): RqlEditorData {
  return {
    tables: RQL_TABLES.map(({ name, description, columns }) => ({
      name,
      description,
      columns: columns.map(({ name, type, description }) => ({ name, type, description })),
    })),
    functions: RQL_FUNCTIONS.map(({ name, signature, returns, description }) => ({
      name,
      signature,
      returns,
      description,
    })),
    keywords: RQL_KEYWORDS,
    // The operators of the schema description: one list for the agent and the person.
    operators: describeRqlSchema().operators,
    properties: { indexed: [...properties.indexed], detected: [...properties.detected] },
  };
}

/**
 * The completions at `pos` of `text`, or null when there are none: inside a string or a comment,
 * or, unless the person asked (`explicit`), where no word is being typed. After FROM: the tables.
 * Else the columns of the table in FROM (of every table before there is one), the functions, the
 * keywords and the operators.
 */
export function rqlCompletions(
  text: string,
  pos: number,
  explicit: boolean,
  data: Pick<RqlEditorData, "properties"> = DATA,
): { from: number; options: RqlCompletion[] } | null {
  const before = text.slice(0, pos);
  const property = PROPERTY_KEY.exec(before);
  if (property) return propertyCompletions(pos - property[1].length, data.properties);
  if (insideStringOrComment(before)) return null;
  const word = /[A-Za-z_][\w]*$/.exec(before);
  if (!word && !explicit) return null;
  const from = word ? pos - word[0].length : pos;
  const previous = /([A-Za-z_]\w*)\s+$/.exec(before.slice(0, from))?.[1]?.toLowerCase();
  if (previous === "from") return { from, options: TABLES };
  const table = /\bfrom\s+([A-Za-z_]\w*)/i.exec(text)?.[1]?.toLowerCase();
  const columns = COLUMNS.get(table ?? "") ?? ALL_COLUMNS;
  return { from, options: [...columns, ...FUNCTIONS, ...KEYWORDS, ...OPERATORS] };
}

const DATA = rqlEditorData();
/** The start of a property name being typed: `properties['` and what follows, to the cursor. */
const PROPERTY_KEY = /\bproperties\s*\[\s*'([^'\n]*)$/;
const NOT_INDEXED_INFO =
  "Not indexed: Ratel stores no values of it. Index it in project settings first.";
const TABLES: RqlCompletion[] = DATA.tables.map(({ name, description }) => ({
  label: name,
  type: "class",
  detail: "table",
  info: description,
}));
const COLUMNS = new Map(
  DATA.tables.map(({ name, columns }) => [
    name as string,
    columns.map(
      ({ name: column, type, description }): RqlCompletion => ({
        label: column,
        type: "property",
        detail: type,
        info: description,
      }),
    ),
  ]),
);
const ALL_COLUMNS: RqlCompletion[] = [
  ...new Map([...COLUMNS.values()].flat().map((column) => [column.label, column])).values(),
];
const FUNCTIONS: RqlCompletion[] = DATA.functions.map(({ name, signature, description }) => ({
  label: name,
  type: "function",
  detail: signature,
  info: description,
}));
const KEYWORDS: RqlCompletion[] = RQL_KEYWORDS.map((label) => ({ label, type: "keyword" }));
const OPERATORS: RqlCompletion[] = [
  ...new Set(DATA.operators.map((operator) => operator.toLowerCase())),
]
  .filter((operator) => !RQL_KEYWORDS.includes(operator as (typeof RQL_KEYWORDS)[number]))
  .map((label) => ({ label, type: "operator" }));

/** The project's property names at `from`: the indexed ones, then the detected ones, off. */
function propertyCompletions(
  from: number,
  properties: RqlEditorData["properties"],
): { from: number; options: RqlCompletion[] } | null {
  const options: RqlCompletion[] = [
    ...properties.indexed.map((label) => ({
      label,
      type: "property" as const,
      detail: "indexed property",
    })),
    ...properties.detected.map((label) => ({
      label,
      type: "property" as const,
      detail: "not indexed",
      info: NOT_INDEXED_INFO,
      disabled: true as const,
    })),
  ];
  return options.length > 0 ? { from, options } : null;
}

/** Whether the end of `before` is inside a 'string' or after `--` on its line. */
function insideStringOrComment(before: string): boolean {
  let quoted = false;
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index];
    if (char === "'") quoted = !quoted;
    else if (!quoted && char === "-" && before[index + 1] === "-") {
      const end = before.indexOf("\n", index);
      if (end === -1) return true;
      index = end;
    }
  }
  return quoted;
}
