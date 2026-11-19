/**
 * Where an edition keeps project API keys so they can be revealed later. Absent in the
 * open-source edition: a key is stored as its hash and prefix only and shown once, at creation.
 *
 * The core hands over every key it issues (onboarding, the API keys settings) right after the
 * key's row exists. Showing a stored key again happens on the edition's own pages, never inside a
 * support session; the core's pages only change their wording when keys can be revealed.
 */
export type ApiKeySecretsPort = {
  /** Whether a key handed over now can be revealed later; the copy that shows a new key says so. */
  revealable(): boolean;
  /**
   * Keep a key just issued for a later reveal. Resolves to whether it was kept. The plaintext is
   * never logged; a failure leaves the key working and shown once.
   */
  store(keyId: string, plaintext: string): Promise<boolean>;
};
