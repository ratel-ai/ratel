/**
 * The line under the key on "<project> is ready", kept short. A later reveal when the edition
 * kept the key (`apiKeySecrets`); otherwise the core stores hash and prefix only and the key is
 * not shown again.
 */
export function onboardingKeyNote(revealable: boolean): string {
  return revealable
    ? "Copy it now or reveal it later in Project settings."
    : "Copy it now; it is not shown again.";
}
