import type { z } from "zod";
import type { BundleStore } from "@/lib/contracts/bundle-store";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageLimitsPort, UsageRefusal } from "@/lib/contracts/usage-limits";
import type { ResolvedApiKeyProject } from "@/lib/platform/api-key-bearer";
import { getLogger } from "@/lib/platform/logger";
import { createVersionSchema } from "./domain/config";
import { bundleKey, type SandboxVersion, versionView } from "./domain/version";
import type { VersionStore } from "./ports/version-store";

/**
 * The push API (`protocol/sandbox/v1`): create a version from an image tarball and its parsed
 * `ratel.yaml`, upload the tarball, finalize it, and read versions. Each call acts on the project
 * of its key. A stored version has no route that edits it.
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
  /** Called one time for each version, when its tarball is complete. */
  onUploaded: (version: SandboxVersion) => Promise<void>;
  /** The configured public origin of this deployment, or null when none is configured. */
  publicOrigin: () => string | null;
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
    if (!input.success) return json(400, refusal("invalid", issueText(input.error.issues[0])));
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
      url: `${originOf(req, deps)}/api/v1/sandboxes/versions/${version.id}/bundle`,
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
      refusal("bundle_mismatch", "The uploaded tarball does not match its SHA-256 and size."),
    );
  });
}

export function handleFinalizeVersion(
  req: Request,
  versionId: string,
  deps: PushApiDeps,
): Promise<Response> {
  return forProject(deps, "finalize_version", async ({ projectId }) => {
    const version = await find(deps, projectId, versionId);
    if (!version) return notFound();
    if (version.status === "uploading") {
      // The store checks the SHA-256 and the size at the upload, and the build checks them again.
      if (!(await isStored(deps.bundles(), bundleKey(version)))) {
        return json(409, refusal("not_uploaded", "The image tarball is not uploaded."));
      }
      const moved = await deps.versions().markUploaded(projectId, version.id);
      if (moved) await deps.onUploaded({ ...version, status: "uploaded" });
    }
    const now = await deps.versions().get(projectId, version.id);
    return now ? json(202, view(req, now, deps)) : notFound();
  });
}

export function handleGetVersion(
  req: Request,
  versionId: string,
  deps: PushApiDeps,
): Promise<Response> {
  return forProject(deps, "get_version", async ({ projectId }) => {
    const version = await find(deps, projectId, versionId);
    return version ? json(200, view(req, version, deps)) : notFound();
  });
}

export function handleListVersions(req: Request, deps: PushApiDeps): Promise<Response> {
  return forProject(deps, "list_versions", async ({ projectId }) => {
    const versions = await deps.versions().list(projectId, LIST_LIMIT);
    return json(200, { versions: versions.map((version) => view(req, version, deps)) });
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

function view(req: Request, version: SandboxVersion, deps: PushApiDeps) {
  return versionView(version, `${originOf(req, deps)}/project/${version.projectId}/sandbox`);
}

/**
 * The configured public origin, else the origin that the client called. Behind a proxy that is the
 * forwarded host. The client sends its key only to the origin of its own base URL.
 */
function originOf(req: Request, deps: PushApiDeps): string {
  const configured = deps.publicOrigin();
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(req.url);
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || null;
  const host = first("x-forwarded-host") ?? first("host") ?? url.host;
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/** Whether the store has the tarball. The open stream is closed at once. */
async function isStored(bundles: BundleStore, key: string): Promise<boolean> {
  const body = await bundles.open(key);
  if (!body) return false;
  await body[Symbol.asyncIterator]().return?.();
  return true;
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

/** The first issue of a refused body, with its path, e.g. `config.params.model.default: ...`. */
function issueText(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "Invalid.";
  const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  const where = path.map(String).join(".");
  const message = issue.code === "unrecognized_keys" ? "This field is not known." : issue.message;
  return `${where ? `${where}: ` : ""}${message}`;
}

function limitReached({ limit, max, current, message }: UsageRefusal, status: number): Response {
  return json(status, { error: "limit_reached", message, limit, max, current });
}

function alreadyStored(): Response {
  return json(409, refusal("already_stored", "The version has its image. Push a new version."));
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
