import { RQL_FUNCTIONS, RQL_TABLES, type RqlTableName, type RqlType } from "./catalog";
import { describeRqlSchema } from "./describe";
import { pairKey, type RqlCompletionUsage, usageKey } from "./usage";

/**
 * What the RQL field of the console offers as a person writes, by the place of the cursor: the
 * tables, the columns of the table in FROM, the functions with their signatures, the keywords and
 * the operators. It reads the same catalog as the compiler and `describe_rql_schema`, so it offers
 * nothing the compiler refuses. The project's trace properties are an input, not part of the
 * catalog: inside `properties['` it offers them, a detected one off. Pure and safe for the browser.
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

/** A word, a value or a symbol of the text, outside the comments. A word is in lower case. */
interface Token {
  kind: "word" | "value" | "symbol";
  text: string;
  start: number;
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
type RqlKeyword = (typeof RQL_KEYWORDS)[number];

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
 * or, unless the person asked (`explicit`), where no word is being typed and the text does not end
 * with a space, a comma, an opening parenthesis or an operator. So the list opens by itself after
 * `select `, `from `, `where `, a comma and an operator, and not right after `*` or `)`. What it
 * offers follows the place of the cursor, in the order of the catalog (`rankRqlCompletions` orders
 * it by the project's usage):
 * - after FROM: the tables;
 * - where an operand starts (after SELECT, WHERE, AND, OR, NOT, HAVING, GROUP BY, ORDER BY, ON, a
 *   comma, an opening parenthesis or a binary operator): the columns of the table in FROM, then
 *   the functions, and no operator. Before there is a table in FROM: the columns of every table,
 *   each once, with its tables in the detail. At the start of a select item, also `*`;
 * - after a whole operand (a column, a literal, a closing parenthesis): the keywords that can
 *   follow in that clause, then the operators.
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
  if (!word && !explicit && !OPENS_BY_ITSELF.test(before)) return null;
  const from = word ? pos - word[0].length : pos;
  const tokens = tokensOf(before.slice(0, from));
  const last = tokens.at(-1);
  // The second word of GROUP BY, ORDER BY and NULLS FIRST: the list starts at the first one.
  if (last?.text === "group" || last?.text === "order")
    return { from: last.start, options: keywords(`${last.text} by`) };
  if (last?.text === "nulls")
    return { from: last.start, options: keywords("nulls first", "nulls last") };
  const options = optionsAfter(tokens, COLUMNS.get(tableOf(text) ?? "") ?? ALL_COLUMNS);
  return options.length > 0 ? { from, options } : null;
}

/**
 * The completions of `rqlCompletions` in the order of a score (decision `completion-ranking`).
 * Each kind keeps its place in the list, and a property that is not indexed stays last. Inside
 * one kind, a name goes up when it holds data in the project, then by how often the saved queries
 * that name a name already in `text` name it too, then by the saved queries that name it. Equal
 * names keep the fixed start order: the order of the catalog. The same names, only reordered: the
 * typed prefix decides which ones match. Pure.
 */
export function rankRqlCompletions(
  text: string,
  found: { from: number; options: RqlCompletion[] },
  usage: RqlCompletionUsage,
): RqlCompletion[] {
  const before = text.slice(0, found.from);
  const inProperty = PROPERTY_KEY.test(before);
  const table = tableOf(text) as RqlTableName | undefined;
  const word = /^[\w]*/.exec(text.slice(found.from))?.[0] ?? "";
  const present = textNames(`${before} ${text.slice(found.from + word.length)}`);
  const groups = [...new Set(found.options.map(groupOf))];
  const scored = found.options.map((option, index) => {
    const key = keyOf(option, inProperty);
    // For each name of the text, the share of its saved queries that name this one too: a name
    // that every query has (the table, `count`) adds as much to each option.
    const together = key
      ? present.reduce(
          (sum, name) =>
            sum + (usage.together[pairKey(key, name)] ?? 0) / Math.max(1, usage.uses[name] ?? 0),
          0,
        )
      : 0;
    return {
      option,
      index,
      group: groups.indexOf(groupOf(option)),
      data: hasNoData(option, inProperty, table, usage) ? 0 : 1,
      together,
      uses: key ? (usage.uses[key] ?? 0) : 0,
    };
  });
  return scored
    .sort(
      (a, b) =>
        a.group - b.group ||
        b.data - a.data ||
        b.together - a.together ||
        b.uses - a.uses ||
        a.index - b.index,
    )
    .map(({ option }) => option);
}

const DATA = rqlEditorData();
/** The end of a text after which the list opens by itself: a space, `,`, `(` or an operator. */
const OPENS_BY_ITSELF = /[\s,(=<>!+\-/]$/;
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
/** Every column of every table, once: its type, then the tables that have it. */
const ALL_COLUMNS: RqlCompletion[] = [
  ...new Map(
    DATA.tables.flatMap(({ columns }) =>
      columns.map(({ name: column, type, description }): [string, RqlCompletion] => [
        column,
        {
          label: column,
          type: "property",
          detail: `${type} · ${DATA.tables
            .filter((table) => table.columns.some((other) => other.name === column))
            .map((table) => table.name)
            .join(", ")}`,
          info: description,
        },
      ]),
    ),
  ).values(),
];
const FUNCTIONS: RqlCompletion[] = DATA.functions.map(({ name, signature, description }) => ({
  label: name,
  type: "function",
  detail: signature,
  info: description,
}));
const LOWER_OPERATORS = [...new Set(DATA.operators.map((operator) => operator.toLowerCase()))];
const isKeyword = (word: string): word is RqlKeyword =>
  (RQL_KEYWORDS as readonly string[]).includes(word);
/** The operators that are not keywords: the symbols, and the ones of two words (`not in`). */
const OPERATORS: RqlCompletion[] = LOWER_OPERATORS.filter((operator) => !isKeyword(operator)).map(
  (label) => ({ label, type: "operator" }),
);
/** The operators that are one keyword and stand between two operands: `and`, `or`, `like`, `in`. */
const WORD_OPERATORS = keywords(
  ...LOWER_OPERATORS.filter(isKeyword).filter((operator) => operator !== "not"),
);
/** The symbols after which an operand starts: `=`, `<`, `+`. */
const SYMBOL_OPERATORS = new Set(LOWER_OPERATORS.filter((operator) => /^\W+$/.test(operator)));
/** The words after which an operand starts. */
const OPERAND_WORDS = new Set([
  ...["select", "distinct", "where", "having", "by", "on"],
  ...["and", "or", "not", "in", "between", "like", "ilike"],
]);
const CLAUSES = new Set(["select", "from", "where", "group", "having", "order", "limit"]);
const STAR: RqlCompletion = { label: "*", type: "keyword", detail: "every column" };

/** The keywords that can follow a whole operand, by the clause it is in. */
const FOLLOWING: Record<string, RqlCompletion[]> = {
  select: keywords("as", "from"),
  where: keywords("group by", "order by", "limit"),
  group: keywords("having", "order by", "limit"),
  having: keywords("order by", "limit"),
  order: keywords("asc", "desc", "nulls first", "nulls last", "limit"),
};
/** After the table in FROM no operator fits: the clauses only. */
const AFTER_TABLE = keywords("where", "group by", "order by", "limit");

/** What the place after `tokens` offers; `columns` are the ones of the table in FROM. */
function optionsAfter(tokens: Token[], columns: RqlCompletion[]): RqlCompletion[] {
  const last = tokens.at(-1);
  if (!last) return keywords("select");
  const previous = tokens.at(-2)?.text;
  const clause = tokens.findLast(({ kind, text }) => kind === "word" && CLAUSES.has(text))?.text;
  const depth = tokens.reduce(
    (open, { text }) => open + (text === "(" ? 1 : text === ")" ? -1 : 0),
    0,
  );
  // `*` is every column after SELECT, a comma or a parenthesis, and a product elsewhere.
  const star = last.text === "*" && ["select", "distinct", ",", "("].includes(previous ?? "");
  if (last.kind === "word" && last.text === "from") return TABLES;
  if (last.text === "is") return keywords("not", "null", "true", "false");
  if (last.text === "not" && previous === "is") return keywords("null", "true", "false");
  // An alias, a row count and the key of `attributes[` are the person's own.
  if (["as", "limit", "["].includes(last.text)) return [];
  if (!star && startsOperand(last)) {
    const item = clause === "select" && depth === 0;
    if (item && last.text === "select")
      return [STAR, ...keywords("distinct"), ...columns, ...FUNCTIONS];
    if (item && (last.text === "distinct" || last.text === ","))
      return [STAR, ...columns, ...FUNCTIONS];
    return [...columns, ...FUNCTIONS];
  }
  // After a whole operand.
  if (depth > 0) return [...WORD_OPERATORS, ...OPERATORS];
  if (clause === "from") return AFTER_TABLE;
  if (clause === "select" && (star || previous === "as")) return keywords("from");
  if (clause === "order" && (last.text === "asc" || last.text === "desc"))
    return keywords("nulls first", "nulls last", "limit");
  const following = FOLLOWING[clause ?? ""];
  return following ? [...following, ...WORD_OPERATORS, ...OPERATORS] : [];
}

/** The table in FROM, anywhere in `text`: the word after it. */
function tableOf(text: string): string | undefined {
  const tokens = tokensOf(text);
  const from = tokens.findIndex(({ kind, text: word }) => kind === "word" && word === "from");
  const table = from === -1 ? undefined : tokens[from + 1];
  return table?.kind === "word" ? table.text : undefined;
}

/** Whether an operand starts after `token`: a keyword, a comma, a parenthesis or an operator. */
function startsOperand({ kind, text }: Token): boolean {
  if (kind === "word") return OPERAND_WORDS.has(text);
  return kind === "symbol" && (text === "," || text === "(" || SYMBOL_OPERATORS.has(text));
}

/** The tokens of `text`, without its comments. */
function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const [found] = match;
    if (found.startsWith("--")) continue;
    const kind = /^[A-Za-z_]/.test(found) ? "word" : /^['"\d]/.test(found) ? "value" : "symbol";
    tokens.push({ kind, text: kind === "word" ? found.toLowerCase() : found, start: match.index });
  }
  return tokens;
}

const TOKEN = /--[^\n]*|'(?:[^']|'')*'|"[^"]*"|[A-Za-z_]\w*|\d+(?:\.\d+)?|<=|>=|<>|!=|[^\s\w]/g;

/** The completions of these keywords: only words of `RQL_KEYWORDS`. */
function keywords(...labels: RqlKeyword[]): RqlCompletion[] {
  return labels.map((label) => ({ label, type: "keyword" }));
}

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

/** The part of the list an option ranks in: its kind, and a property that is not indexed apart. */
function groupOf(option: RqlCompletion): string {
  return option.disabled ? `${option.type}:off` : option.type;
}

/** The usage key of an option, or null for a keyword or an operator, which keep their place. */
function keyOf(option: RqlCompletion, inProperty: boolean): string | null {
  if (inProperty) return usageKey("property", option.label);
  if (option.type === "class") return usageKey("table", option.label);
  if (option.type === "property") return usageKey("column", option.label);
  if (option.type === "function") return usageKey("function", option.label);
  return null;
}

/**
 * Whether the project's data says the option holds none: a column of a table that was read and
 * holds no value in it (before FROM: in no table read), or a property with no value. No reading
 * is no evidence.
 */
function hasNoData(
  option: RqlCompletion,
  inProperty: boolean,
  table: RqlTableName | undefined,
  { columnsWithData, propertiesWithData }: RqlCompletionUsage,
): boolean {
  if (inProperty) return propertiesWithData !== null && !propertiesWithData.includes(option.label);
  if (option.type !== "property") return false;
  const tables = table
    ? [table]
    : DATA.tables
        .filter(({ columns }) => columns.some(({ name }) => name === option.label))
        .map(({ name }) => name);
  const read = tables.filter((name) => columnsWithData[name] !== undefined);
  return read.length > 0 && read.every((name) => !columnsWithData[name]?.includes(option.label));
}

/** The usage keys a text may name: each word as a table, a column or a function, and each property key. */
function textNames(text: string): string[] {
  const names = new Set<string>();
  for (const { kind, text: word } of tokensOf(text))
    if (kind === "word" && !isKeyword(word))
      for (const as of ["table", "column", "function"] as const) names.add(usageKey(as, word));
  for (const [, name] of text.matchAll(/\bproperties\s*\[\s*'([^'\n]+)'/g))
    names.add(usageKey("property", name));
  return [...names];
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
