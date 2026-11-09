"use client";

import { Button } from "@ratel/design-system/button";
import { Plus } from "lucide-react";
import { useFormStatus } from "react-dom";

/**
 * "New project": submits the existing creation action, which refuses at the
 * plan's cap and otherwise opens onboarding for this organization. At the cap
 * the button stays visible but off, and the page says why.
 */
export function NewProjectButton({
  action,
  atCap,
}: {
  action: () => Promise<void>;
  atCap: boolean;
}) {
  return (
    <form action={action}>
      <SubmitButton disabled={atCap} />
    </form>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={disabled} loading={pending}>
      {pending ? null : <Plus aria-hidden />}
      {pending ? "Opening…" : "New project"}
    </Button>
  );
}
