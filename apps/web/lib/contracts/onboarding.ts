import type { Organization } from "@/lib/contracts/session";

/**
 * Project creation, lent to an edition whose own pages onboard people outside the console (the
 * Cloud edition's invitation page). Projects, API keys and the sample project are the core's, so
 * the edition asks for them here instead of writing those tables.
 *
 * The edition answers for who is asking: it resolves the session, refuses a support session and
 * passes the organization the person acts in. The core does the rest as its own onboarding does:
 * the name rules, the plan's project cap through the entitlements port, the project, its first
 * key and the product events.
 */

/** The send-your-first-trace snippets, as data, so the edition renders them in its own page. */
export type QuickstartSamples = {
  /** The environment variable every snippet reads the key from; no snippet inlines the key. */
  keyEnv: string;
  /** The shell line that installs what the first snippet imports. */
  install: string | null;
  samples: readonly { label: string; code: string }[];
};

export type FirstProjectInput = {
  name: string;
  /** The organization the person acts in. The edition may pass its wider row. */
  organization: Organization;
  /** The person's stable id (`SessionUser.externalId`), for the product events. */
  externalId: string;
  /** This deployment's absolute OTLP traces URL, written into the snippets. */
  ingestUrl: string;
};

export type FirstProjectResult =
  | { ok: false; error: string }
  | {
      ok: true;
      id: string;
      name: string;
      slug: string;
      /** The key's plaintext, once: only its hash is stored. */
      apiKey: string;
      quickstart: QuickstartSamples;
    };

export type OnboardingPort = {
  createFirstProject(input: FirstProjectInput): Promise<FirstProjectResult>;
  /** Gives an organization with no projects its sample project, once. Never throws. */
  ensureSampleProject(input: { organization: Organization; externalId: string }): Promise<void>;
};
