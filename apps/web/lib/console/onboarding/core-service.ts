import {
  type CreateFirstProjectDeps,
  createFirstProject,
} from "@/lib/console/onboarding/create-first-project";
import {
  type EnsureSampleProjectContext,
  ensureSampleProject,
} from "@/lib/console/onboarding/provision-sample";
import {
  buildQuickstartSet,
  QUICKSTART_KEY_ENV,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
} from "@/lib/console/onboarding/quickstart";
import type { OnboardingPort } from "@/lib/contracts/onboarding";
import { generateApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { checkQuota } from "@/lib/platform/entitlements";
import {
  createApiKey,
  createProject,
  listProjectsForOrganization,
} from "@/lib/platform/projects/queries";
import { trackProductEvent } from "@/lib/platform/telemetry";

/**
 * The onboarding the core lends an edition (`CoreServices.onboarding`): the same
 * `createFirstProject` the `/onboarding` action runs, the same snippets and the same sample
 * project, for a page the edition owns. The edition has already resolved who is asking and
 * refused a support session, so the session here is the organization and person it passes.
 */
export type OnboardingServiceDeps = Omit<CreateFirstProjectDeps, "session" | "actingAs"> & {
  ensureSampleProject: (context: EnsureSampleProjectContext) => Promise<unknown>;
};

const defaultDeps: OnboardingServiceDeps = {
  dbConfigured: isDbConfigured,
  listProjects: (id) => listProjectsForOrganization(id),
  createProject: (input) => createProject(input),
  createApiKey: (input) => createApiKey(input),
  generateApiKey,
  checkQuota,
  track: trackProductEvent,
  ensureSampleProject: (context) => ensureSampleProject(context),
};

export function createOnboardingService(deps: OnboardingServiceDeps = defaultDeps): OnboardingPort {
  const { ensureSampleProject: ensureSample, ...projectDeps } = deps;
  return {
    async createFirstProject({ name, organization, externalId, ingestUrl }) {
      const created = await createFirstProject(
        { name, organizationId: organization.id },
        {
          ...projectDeps,
          session: async () => ({ user: { externalId }, organization }),
          actingAs: async () => null,
        },
      );
      if (!created) return { ok: false, error: "Could not create the project. Try again." };
      if (!created.ok) return created;

      const snippets = buildQuickstartSet({ endpoint: ingestUrl, serviceName: created.slug });
      return {
        ok: true,
        id: created.id,
        name: created.name,
        slug: created.slug,
        apiKey: created.apiKey,
        quickstart: {
          keyEnv: QUICKSTART_KEY_ENV,
          install: snippets.typescript.install,
          samples: QUICKSTART_LANGS.map((lang) => ({
            label: QUICKSTART_LANG_LABELS[lang],
            code: snippets[lang].code,
          })),
        },
      };
    },
    async ensureSampleProject(context) {
      await ensureSample(context);
    },
  };
}
