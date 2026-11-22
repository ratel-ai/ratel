/**
 * The training opt-in of a project (RC-1123). A grant is active until it is
 * withdrawn. Pure types: the store reads and writes them.
 */

export interface TrainingConsent {
  id: string;
  projectId: string;
  /** The Clerk id of the admin who gave it. */
  givenBy: string;
  givenAt: Date;
  /** The consent copy the admin saw (`TRAINING_CONSENT_VERSION`). */
  textVersion: string;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
}

/** Why a consent change was refused. */
export type ConsentRejection = "stale_text" | "not_given";

export const CONSENT_REJECTIONS: Record<ConsentRejection, string> = {
  stale_text: "The opt-in text changed. Reload the page and read it again.",
  not_given: "This project has no training opt-in to withdraw.",
};

/** The view of the consent a page or tool shows. */
export interface ConsentView {
  active: boolean;
  givenBy: string | null;
  givenAt: string | null;
  textVersion: string | null;
}

export function consentView(consent: TrainingConsent | null): ConsentView {
  if (!consent || consent.withdrawnAt)
    return { active: false, givenBy: null, givenAt: null, textVersion: null };
  return {
    active: true,
    givenBy: consent.givenBy,
    givenAt: consent.givenAt.toISOString(),
    textVersion: consent.textVersion,
  };
}
