/**
 * The line under "<project> is ready" at onboarding. Upstream's when the edition kept the key for
 * a later reveal (`apiKeySecrets`); otherwise the core stores hash and prefix only and the key is
 * not shown again.
 */
export function onboardingKeyNote(revealable: boolean): string {
  return revealable
    ? "Treat this API key like a password. Copy it now or reveal it later in Project settings."
    : "Treat this API key like a password. Copy it now; it is not shown again.";
}
