/** Terraform seeds every human-supplied secret with this until an operator sets it. */
const SECRET_PLACEHOLDER = "REPLACE_ME";

/** A setting's trimmed value, or undefined when it is empty or still the Terraform placeholder. */
export function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== SECRET_PLACEHOLDER ? trimmed : undefined;
}
