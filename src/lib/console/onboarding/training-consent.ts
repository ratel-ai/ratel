/**
 * The training opt-in copy (fine-tuning, RC-1123), in one place.
 *
 * Kept out of the component for the same reason as the capture copy next to
 * it: this is a promise about someone's data. `fine_tuning_consents` stores
 * the version an admin agreed to, so change the version with the text.
 */

export const TRAINING_CONSENT_VERSION = "2026-11-20";

export const TRAINING_CONSENT_TITLE = "Use this project's model calls for fine-tuning datasets";

/** What the admin agrees to, one promise per line. */
export const TRAINING_CONSENT_TERMS: readonly string[] = [
  "Ratel copies the text of this project's model calls (prompts and replies) into fine-tuning datasets.",
  "The datasets stay in Ratel. Nothing goes to a training provider.",
  "Training on a backend outside Ratel needs a separate opt-in later.",
  "Withdrawing the opt-in deletes every dataset of this project.",
];
