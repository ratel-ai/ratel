"use client";

import { Toast } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { buttonVariants } from "./button-variants";

/**
 * One toast stack for the whole app. The manager is module-level so any client
 * code can call `toast()`; `<Toaster />` is mounted once by the shell.
 */
const manager = Toast.createToastManager();

export type ToastTone = "neutral" | "success" | "danger";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Undo for reversible changes (DESIGN.md, Destructive actions). */
  action?: { label: string; onClick: () => void };
  /** Milliseconds; 0 keeps it until dismissed. Toasts with an action stay 8 s. */
  timeout?: number;
};

export function toast({
  title,
  description,
  tone = "neutral",
  action,
  timeout,
}: ToastOptions): string {
  const id: string = manager.add({
    title,
    description,
    type: tone,
    timeout: timeout ?? (action ? 8000 : 5000),
    actionProps: action
      ? {
          children: action.label,
          // The action runs once: the toast closes as it fires, so Undo can't be sent twice.
          onClick: () => {
            manager.close(id);
            action.onClick();
          },
        }
      : undefined,
  });
  return id;
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={manager}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root
      key={item.id}
      toast={item}
      className="rounded-xl border border-line bg-overlay p-3 text-fg shadow-overlay transition-[translate,opacity] duration-200 ease-enter data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-120 motion-reduce:transition-none"
    >
      <div className="flex items-start gap-2.5">
        <ToneIcon tone={item.type as ToastTone | undefined} />
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-ui font-medium text-fg" />
          <Toast.Description className="mt-0.5 text-xs text-fg-muted" />
        </div>
        <Toast.Action className={buttonVariants({ variant: "ghost", size: "sm" })} />
        <Toast.Close
          aria-label="Dismiss"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X className="size-3.5" aria-hidden />
        </Toast.Close>
      </div>
    </Toast.Root>
  ));
}

function ToneIcon({ tone }: { tone: ToastTone | undefined }) {
  if (tone === "success")
    return <CheckCircle2 aria-hidden className="mt-px size-4 shrink-0 text-success" />;
  if (tone === "danger")
    return <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-danger" />;
  return <Info aria-hidden className="mt-px size-4 shrink-0 text-fg-subtle" />;
}
