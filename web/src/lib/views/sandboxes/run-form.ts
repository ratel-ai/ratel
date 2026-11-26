/**
 * The values of the run panel of the sandbox page, as the form keeps them and as the runs API takes
 * them. Pure: the client imports it.
 */

/** One declared parameter of a version, as `ratel.yaml` gives it. */
export type ParamSpec = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  default: string | number | boolean | null;
  description: string | null;
  /** The options of an enum. Empty for the other types. */
  options: Array<string | number>;
};

/** What the form holds for each parameter: text for a field, a flag for a switch. */
export type ParamDraft = Record<string, string | boolean>;

/** The input as the editor shows it: plain text when the example is a string, else JSON. */
export type InputDraft = { kind: "text" | "json"; text: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The editor text of the input example of a version. */
export function inputDraftOf(example: unknown): InputDraft {
  if (typeof example === "string") return { kind: "text", text: example };
  return { kind: "json", text: JSON.stringify(example ?? null, null, 2) };
}

/** The input that the run gets. JSON text must parse. */
export function inputOfDraft(draft: InputDraft): Parsed<unknown> {
  if (draft.kind === "text") return { ok: true, value: draft.text };
  try {
    return { ok: true, value: JSON.parse(draft.text) };
  } catch {
    return { ok: false, error: "The input must be JSON." };
  }
}

/** The form values at the defaults of the version. */
export function paramDraftOf(params: readonly ParamSpec[]): ParamDraft {
  return Object.fromEntries(
    params.map((param) => [
      param.name,
      param.type === "boolean" ? param.default === true : String(param.default ?? ""),
    ]),
  );
}

/**
 * The params that the run gets, typed as the version declares them. An empty field sends nothing,
 * so the version's default applies. A number that does not parse is refused with its name.
 */
export function paramsOfDraft(
  params: readonly ParamSpec[],
  draft: ParamDraft,
):
  | { ok: true; value: Record<string, string | number | boolean> }
  | { ok: false; errors: Record<string, string> } {
  const value: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};
  for (const param of params) {
    const raw = draft[param.name];
    if (param.type === "boolean") {
      value[param.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") continue;
    if (param.type === "number") {
      const number = Number(text);
      if (Number.isFinite(number)) value[param.name] = number;
      else errors[param.name] = `${param.name} must be a number.`;
    } else if (param.type === "enum") {
      const option = param.options.find((candidate) => String(candidate) === text);
      if (option === undefined)
        errors[param.name] = `${param.name} must be one of: ${param.options.join(", ")}.`;
      else value[param.name] = option;
    } else {
      value[param.name] = text;
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * The expected output of a case saved from a run: the output text, or its JSON when it is not a
 * string. Null when the run has no output.
 */
export function expectedOutputOf(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}
