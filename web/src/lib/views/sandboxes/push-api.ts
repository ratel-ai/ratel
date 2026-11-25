import type { BundleStore } from "@/lib/contracts/bundle-store";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageLimitsPort, UsageRefusal } from "@/lib/contracts/usage-limits";
import type { ResolvedApiKeyProject } from "@/lib/platform/api-key-bearer";
import { getLogger } from "@/lib/platform/logger";
import { checkBundle } from "./domain/bundle-check";
import { createVersionSchema } from "./domain/manifest";
import { bundleKey, type SandboxVersion, versionView } from "./domain/version";
import type { VersionStore } from "./ports/version-store";

/**
 * The push API (`protocol/sandbox/v1`): create a version, upload its bundle, finalize it, and read
 * versions. Each call acts on the project of its key. A stored version has no route that edits it.
 */
export type PushApiDeps = {
  /** True when no project of the deployment can have the flag: the route then answers 404 first. */
  offForAll: () => boolean;
  authenticate: () => Promise<ResolvedApiKeyProject>;
  enabled: (projectId: string) => Promise<boolean>;
  organizationIdOf: (projectId: string) => Promise<string | null>;
  versions: () => VersionStore;
  bundles: () => BundleStore;
  limits: () => UsageLimitsPort;
  /** Whether this deployment can build and run sandboxes. */
  providerConfigured: () => boolean;
  /** Called one time for each version, when its bundle is complete. */
  onUploaded: (version: SandboxVersion) => Promise<void>;
  publicUrl: (path: string) => string;
};

type Project = { projectId: string; apiKeyId: string };

const MAX_JSON_BYTES = 1024 * 1024;
const LIST_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const NOT_CONFIGURED_MESSAGE =
  "Ratel sandbox is not configured on this deployment. An operator must set it up.";

const logger = getLogger("sandboxes/push-api");

export function handleCreateVersion(req: Request, deps: PushApiDeps): Promise<Response> {
  return forProject(deps, "create_version", async ({ projectId, apiKeyId }) => {
    if (!deps.providerConfigured())
      return json(503, refusal("not_configured", NOT_CONFIGURED_MESSAGE));
    const input = createVersionSchema.safeParse(await readJson(req));
    if (!input.success) {
      const issue = input.error.issues[0];
      const where = issue?.path.join(".");
      return json(
        400,
        refusal("invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`),
      );
    }
    const organizationId = await deps.organizationIdOf(projectId);
    if (!organizationId) return notFound();
    const subject = { organizationId, projectId };
    const limits = deps.limits();
    const size = await limits.check(subject, "sandbox_bundle_bytes", {
      current: 0,
      amount: input.data.bundle.bytes,
    });
    if (!size.ok) return limitReached(size, 413);

    const created = await deps
      .versions()
      .create({ ...input.data, projectId, apiKeyId }, (current) =>
        limits.check(subject, "sandbox_versions_per_day", { current }),
      );
    if (!created.ok) return limitReached(created, 429);
    const { version } = created;
    await limits.record(subject, { kind: "sandbox_version", reference: version.id });
    logger.info(
      { project_id: projectId, version_id: version.id, bundle_bytes: version.bundle.bytes },
      "sandbox version created",
    );
    const target = await deps.bundles().uploadTarget(bundleKey(version), version.bundle);
    const upload = target ?? {
      url: deps.publicUrl(`/api/v1/sandboxes/versions/${version.id}/bundle`),
      headers: { "content-type": "application/gzip" },
    };
    return json(201, {
      versionId: version.id,
      // The client adds its key only when the upload goes to Ratel.
      upload: { method: "PUT", ...upload, authorize: target === null },
    });
  });
}

export function handleUploadBundle(req: Request, versionId: string, deps: PushApiDeps) {
  return forProject(deps, "upload_bundle", async ({ projectId }) => {
    const version = await find(deps, projectId, versionId);
    if (!version) return notFound();
    if (version.status !== "uploading") return alreadyStored();
    if (!req.body) return json(400, refusal("invalid", "The request has no body."));
    const stored = await deps
      .bundles()
      .put(bundleKey(version), req.body as unknown as AsyncIterable<Uint8Array>, version.bundle);
    if (stored.ok) return new Response(null, { status: 204 });
    if (stored.reason === "exists") return alreadyStored();
    return json(
      409,
      refusal("bundle_mismatch", "The uploaded bundle does not match its SHA-256 and size."),
    );
  });
}

export function handleFinalizeVersion(versionId: string, deps: PushApiDeps): Promise<Response> {
  return forProject(deps, "finalize_version", async ({ projectId }) => {
    const version = await find(deps, projectId, versionId);
    if (!version) return notFound();
    if (version.status === "uploading") {
      const body = await deps.bundles().open(bundleKey(version));
      if (!body) return json(409, refusal("not_uploaded", "The bundle is not uploaded."));
      const checked = await checkBundle(body, version.bundle);
      if (!checked.ok) {
        logger.info({ project_id: projectId, version_id: versionId }, "sandbox bundle refused");
        return json(422, refusal("bundle_refused", checked.message));
      }
      const moved = await deps.versions().markUploaded(projectId, version.id);
      if (moved) await deps.onUploaded({ ...version, status: "uploaded" });
    }
    const now = await deps.versions().get(projectId, version.id);
    return now ? json(202, versionView(now)) : notFound();
  });
}

export function handleGetVersion(versionId: string, deps: PushApiDeps): Promise<Response> {
  return forProject(deps, "get_version", async ({ projectId }) => {
    const version = await find(deps, projectId, versionId);
    return version ? json(200, versionView(version)) : notFound();
  });
}

export function handleListVersions(deps: PushApiDeps): Promise<Response> {
  return forProject(deps, "list_versions", async ({ projectId }) => {
    const versions = await deps.versions().list(projectId, LIST_LIMIT);
    return json(200, { versions: versions.map(versionView) });
  });
}

async function forProject(
  deps: PushApiDeps,
  operation: string,
  work: (project: Project) => Promise<Response>,
): Promise<Response> {
  if (deps.offForAll()) return notFound();
  const resolved = await deps.authenticate();
  if (!resolved.ok) return resolved.response;
  const { projectId, apiKeyId } = resolved;
  if (!(await deps.enabled(projectId))) return notFound();
  return withFeatureSpan("sandboxes", operation, () => work({ projectId, apiKeyId }), {
    attributes: { "project.id": projectId },
  });
}

async function find(deps: PushApiDeps, projectId: string, versionId: string) {
  return UUID.test(versionId) ? deps.versions().get(projectId, versionId) : null;
}

async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function limitReached({ limit, max, current, message }: UsageRefusal, status: number): Response {
  return json(status, { error: "limit_reached", message, limit, max, current });
}

function alreadyStored(): Response {
  return json(409, refusal("already_stored", "The version has its bundle. Push a new version."));
}

function notFound(): Response {
  return json(404, refusal("not_found", "Not found."));
}

function refusal(error: string, message: string) {
  return { error, message };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
