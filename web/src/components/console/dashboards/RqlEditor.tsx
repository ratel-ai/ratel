"use client";

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  closeCompletion,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { SQLDialect } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import { PropertyBlockNote } from "@/components/console/properties/PropertyBlockNote";
import { usePropertyChoices } from "@/components/console/properties/PropertyChoicesProvider";
import {
  RQL_KEYWORDS,
  type RqlEditorData,
  rankRqlCompletions,
  rqlCompletions,
  rqlEditorData,
} from "@/lib/synthesis/rql/domain/editor";
import { NO_USAGE, type RqlCompletionUsage } from "@/lib/synthesis/rql/domain/usage";
import { type PropertyBlock, propertyBlock } from "@/lib/views/dashboards/properties";

/**
 * The RQL field with highlighting and completion, from the compiler's catalog and the project's
 * trace properties. Loaded only where the field is shown (`SqlFields` imports it on demand); the
 * plain text area stands in until then. The list opens by itself where the domain gives one, and
 * is ordered by the project's usage (`rankRqlCompletions`) once the page's read of it arrives. A
 * property that is not indexed is offered off: picking it writes nothing and shows why, with the
 * link that fixes it.
 */

const DATA = rqlEditorData();

/** RQL's words as a SQL dialect: the highlighter knows its keywords and functions, no others. */
const RQL_DIALECT = SQLDialect.define({
  keywords: [...new Set(RQL_KEYWORDS.flatMap((keyword) => keyword.split(" ")))].join(" "),
  builtin: DATA.functions.map((fn) => fn.name).join(" "),
  types: "",
  identifierQuotes: '"',
});

/** The console's tokens: the same rules in light and dark, as the variables change with the theme. */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--color-accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-success)" },
  { tag: tags.number, color: "var(--color-info)" },
  { tag: [tags.bool, tags.null], color: "var(--color-info)" },
  { tag: tags.standard(tags.name), color: "var(--color-chart-3)" },
  {
    tag: [tags.lineComment, tags.blockComment],
    color: "var(--color-fg-subtle)",
    fontStyle: "italic",
  },
  { tag: tags.operator, color: "var(--color-fg-muted)" },
]);

const THEME = EditorView.theme({
  "&": {
    fontSize: "var(--text-xs)",
    color: "var(--color-fg)",
    backgroundColor: "var(--color-app)",
    border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-md, 0.375rem)",
  },
  "&.cm-focused": { outline: "2px solid var(--color-focus)", outlineOffset: "1px" },
  "&[data-invalid]": { borderColor: "var(--color-danger)" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "0.5rem 0",
    minHeight: "7rem",
    caretColor: "var(--color-fg)",
  },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-scroller": { maxHeight: "18rem", overflow: "auto" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--color-selected)",
  },
  ".cm-placeholder": { color: "var(--color-fg-faint)" },
  ".cm-rql-error": {
    textDecoration: "underline wavy var(--color-danger)",
    textUnderlineOffset: "3px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--color-overlay)",
    border: "1px solid var(--color-line)",
    color: "var(--color-fg)",
    borderRadius: "0.5rem",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-selected)",
    color: "var(--color-fg)",
  },
  ".cm-rql-off, .cm-rql-off .cm-completionDetail": { color: "var(--color-fg-faint)" },
  ".cm-completionDetail": { color: "var(--color-fg-subtle)", fontStyle: "normal" },
  ".cm-completionInfo": { maxWidth: "20rem", padding: "0.375rem 0.5rem" },
});

/** The compiler's error position, marked in the text. */
const setError = StateEffect.define<{ start: number; end: number } | null>();
const errorMark = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setError)) {
        const at = effect.value;
        const length = transaction.state.doc.length;
        next =
          at && at.start < at.end && at.end <= length
            ? Decoration.set([Decoration.mark({ class: "cm-rql-error" }).range(at.start, at.end)])
            : Decoration.none;
      }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The completions at the cursor, in the order of the domain, ranked by the project's usage. The
 * list sorts by how well an option matches the typed prefix, then by boost, then by `sortText`:
 * each kind (columns, functions, keywords, operators) gets a boost by its place in that order, and
 * `sortText` keeps the rank inside a kind. A property that is not indexed calls `blocked` instead
 * of writing.
 */
function completer(
  data: () => { editor: Pick<RqlEditorData, "properties">; usage: RqlCompletionUsage },
  blocked: (name: string) => void,
) {
  return (context: CompletionContext) => {
    const text = context.state.doc.toString();
    const { editor, usage } = data();
    const found = rqlCompletions(text, context.pos, context.explicit, editor);
    if (!found) return null;
    const ranked = rankRqlCompletions(text, found, usage);
    const kinds = [...new Set(ranked.map((option) => option.type))];
    const width = String(ranked.length).length;
    const options = ranked.map(({ disabled, ...option }, index): Completion => {
      const sortText = String(index).padStart(width, "0");
      return disabled
        ? { ...option, sortText, boost: -1, apply: () => blocked(option.label) }
        : { ...option, sortText, boost: kinds.length - 1 - kinds.indexOf(option.type) };
    });
    // A property name can hold any character but a quote. A word of the query ends at a space:
    // the next place has its own list.
    const inName = context.state.sliceDoc(found.from - 1, found.from) === "'";
    return { ...found, options, validFor: inName ? /^[^'\n]*$/ : /^\w*$/ };
  };
}

export function RqlEditor({
  value,
  maxLength,
  errorAt,
  onChange,
  onRun,
  control,
}: {
  value: string;
  maxLength: number;
  /** Where the compiler's refusal is in `value`, or null. */
  errorAt: { start: number; end: number } | null;
  onChange: (text: string) => void;
  /** ⌘Enter. */
  onRun: () => void;
  /** The field's label and note: the label names the editor for a screen reader. */
  control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true };
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Whether the person moved through the open list since the last change of the text.
  const moved = useRef(false);
  const { projectId, choices, usage: usageRead } = usePropertyChoices();
  const [block, setBlock] = useState<PropertyBlock | null>(null);
  const [saved, setSaved] = useState<RqlCompletionUsage>(NO_USAGE);
  // The page's read of the usage: the list keeps its start order until it arrives.
  useEffect(() => {
    let current = true;
    // A streamed promise is a thenable whose `then` returns nothing: wrap it.
    if (usageRead)
      Promise.resolve(usageRead)
        .then((read) => current && setSaved(read))
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [usageRead]);
  const data = useMemo(
    () => ({
      editor: rqlEditorData({
        indexed: choices.indexed.map(({ name }) => name),
        detected: choices.detected.map(({ name }) => name),
      }),
      // An indexed property holds data when it has values in the page's range.
      usage: {
        ...saved,
        propertiesWithData: choices.indexed
          .filter(({ values }) => values.length > 0)
          .map(({ name }) => name),
      },
    }),
    [choices, saved],
  );
  // The latest callbacks and properties, read by the editor made once.
  const latest = useRef({ onChange, onRun, data });
  latest.current = { onChange, onRun, data };
  const blocked = useRef((name: string) => setBlock(propertyBlock(projectId, choices, name)));
  blocked.current = (name: string) => setBlock(propertyBlock(projectId, choices, name));

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is made once; a new text comes through the effect below.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Before the completion's own keys, which take the highest precedence.
          Prec.highest(
            keymap.of([
              // A list that opened by itself with no word typed: Enter is a new line until the
              // person moves through the list. Enter after a word still picks the first option.
              ...["ArrowDown", "ArrowUp", "PageDown", "PageUp"].map((key) => ({
                key,
                run: () => {
                  moved.current = true;
                  return false;
                },
              })),
              {
                key: "Enter",
                run: (editor) => {
                  if (moved.current || completionStatus(editor.state) !== "active") return false;
                  const at = editor.state.selection.main.head;
                  if (/\w$/.test(editor.state.sliceDoc(Math.max(0, at - 1), at))) return false;
                  closeCompletion(editor);
                  return false;
                },
              },
            ]),
          ),
          history(),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                latest.current.onRun();
                return true;
              },
            },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          RQL_DIALECT.language,
          syntaxHighlighting(HIGHLIGHT),
          autocompletion({
            override: [
              completer(
                () => latest.current.data,
                (name) => blocked.current(name),
              ),
            ],
            icons: true,
            // A property that is not indexed is shown off.
            optionClass: (option) => (option.boost === -1 ? "cm-rql-off" : ""),
          }),
          // The text length cap: a change past it does not happen.
          EditorState.transactionFilter.of((transaction) =>
            transaction.docChanged && transaction.newDoc.length > maxLength ? [] : transaction,
          ),
          errorMark,
          EditorView.lineWrapping,
          placeholder("select count(*) from traces"),
          THEME,
          EditorView.contentAttributes.of({
            id: control.id,
            "aria-multiline": "true",
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            moved.current = false;
            latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // A text from outside (a dropdown of the form) replaces the one in the editor.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setError.of(errorAt) });
  }, [errorAt]);

  // A new text closes the note of a property that is not indexed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the note follows the text.
  useEffect(() => setBlock(null), [value]);

  // The label and note of the field reach the editor's text box.
  useEffect(() => {
    const content = view.current?.contentDOM;
    if (!content) return;
    const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (label) {
      label.id ||= `${control.id}-label`;
      content.setAttribute("aria-labelledby", label.id);
    }
    if (control["aria-describedby"])
      content.setAttribute("aria-describedby", control["aria-describedby"]);
    else content.removeAttribute("aria-describedby");
    if (control["aria-invalid"]) {
      content.setAttribute("aria-invalid", "true");
      view.current?.dom.setAttribute("data-invalid", "");
    } else {
      content.removeAttribute("aria-invalid");
      view.current?.dom.removeAttribute("data-invalid");
    }
  }, [control]);

  return (
    <div>
      <div ref={host} data-rql-editor="" />
      {block ? <PropertyBlockNote block={block} onClose={() => setBlock(null)} /> : null}
    </div>
  );
}
