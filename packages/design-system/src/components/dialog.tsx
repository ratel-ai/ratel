"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../cn";
import { Button } from "./button";
import { Input } from "./input";
import { toast } from "./toast";

const BACKDROP =
  "fixed inset-0 z-dialog bg-scrim transition-opacity duration-160 ease-enter data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";
// Tall forms scroll inside the dialog: a modal dialog locks the page's scroll.
const POPUP =
  "fixed top-[min(20vh,12rem)] left-1/2 z-dialog flex max-h-[calc(100dvh-min(20vh,12rem)-1rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-xl border border-line bg-overlay p-5 text-fg shadow-dialog outline-none focus-visible:outline-none transition-[translate,opacity] duration-200 ease-enter data-starting-style:translate-y-1 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-120 motion-reduce:transition-none";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

/**
 * A centered dialog for short forms (five fields or fewer). Never for reading
 * and never nested (DESIGN.md, Overlays). Use `Panel` to inspect an item and
 * `ConfirmDialog` for anything irreversible.
 *
 * The close button comes after the content in the DOM (it is positioned in the
 * corner), so opening the dialog focuses its first field, not "Close".
 */
export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned: secondary first, the primary action last. */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={BACKDROP} />
      <BaseDialog.Popup className={cn(POPUP, className)}>
        <div className="pr-8">
          <BaseDialog.Title className="text-sm font-semibold text-fg">{title}</BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="mt-1 text-sm text-fg-muted">
              {description}
            </BaseDialog.Description>
          ) : null}
        </div>
        {children}
        {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
        <BaseDialog.Close
          aria-label="Close"
          className="absolute top-3.5 right-3.5 inline-flex size-7 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X className="size-4" aria-hidden />
        </BaseDialog.Close>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question naming the action: "Delete Demo project?" */
  title: string;
  /** The consequence in one sentence. */
  description: ReactNode;
  /** Named after the action: "Delete project", never "OK". */
  confirmLabel: string;
  /**
   * Runs the action, with the text the person typed when `requireText` is
   * set (send that, so the server checks what was typed). A rejection shows
   * the dialog's own failure toast.
   */
  onConfirm: (typed: string) => void | Promise<void>;
  /** When set, the action stays disabled until this exact text is typed. */
  requireText?: string;
  pending?: boolean;
};

/**
 * Confirmation for irreversible actions only. Reversible ones happen at once
 * with an Undo toast instead (DESIGN.md, Destructive actions).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={BACKDROP} />
        <AlertDialog.Popup className={POPUP}>
          {/* Inside the popup, so the typed text unmounts with it: every open
              starts empty, however the dialog was closed. */}
          <ConfirmBody {...props} />
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function ConfirmBody({
  title,
  description,
  confirmLabel,
  onConfirm,
  requireText,
  pending = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const blocked = requireText !== undefined && typed.trim() !== requireText;

  async function confirm() {
    setRunning(true);
    try {
      await onConfirm(typed);
    } catch {
      // The caller owns the specific message; never let a failure pass silently.
      toast({
        title: `Couldn't finish: ${confirmLabel.toLowerCase()}`,
        description: "Nothing changed. Try again in a moment.",
        tone: "danger",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div>
        <AlertDialog.Title className="text-sm font-semibold text-fg">{title}</AlertDialog.Title>
        <AlertDialog.Description className="mt-1 text-sm text-fg-muted">
          {description}
        </AlertDialog.Description>
      </div>
      {requireText !== undefined ? (
        // biome-ignore lint/a11y/noLabelWithoutControl: the label wraps the input below.
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">
          <span>
            Type <span className="font-mono text-fg">{requireText}</span> to confirm
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <AlertDialog.Close render={<Button variant="secondary" />}>Cancel</AlertDialog.Close>
        <Button
          variant="danger"
          loading={pending || running}
          disabled={blocked}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </div>
    </>
  );
}
