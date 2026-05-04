import * as clack from "@clack/prompts";

export const CANCEL_SYMBOL = Symbol("ratel.prompt.cancel");

export interface PromptAdapter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  select<T>(opts: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initialValue?: T;
  }): Promise<T | symbol>;
  multiselect<T>(opts: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    required?: boolean;
    initialValues?: T[];
  }): Promise<T[] | symbol>;
  text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
  cancel(message?: string): void;
}

export function defaultPromptAdapter(): PromptAdapter {
  return {
    intro: clack.intro,
    outro: clack.outro,
    note: clack.note,
    confirm: clack.confirm as PromptAdapter["confirm"],
    select: clack.select as PromptAdapter["select"],
    multiselect: clack.multiselect as PromptAdapter["multiselect"],
    text: clack.text as PromptAdapter["text"],
    isCancel: clack.isCancel,
    cancel: clack.cancel,
  };
}

export function silentPromptAdapter(): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note() {},
    async confirm() {
      return true;
    },
    async select() {
      return CANCEL_SYMBOL;
    },
    async multiselect() {
      return CANCEL_SYMBOL;
    },
    async text() {
      return "";
    },
    isCancel(value) {
      return value === CANCEL_SYMBOL;
    },
    cancel() {},
  };
}
