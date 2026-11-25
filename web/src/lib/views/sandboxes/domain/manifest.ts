import { z } from "zod";

/** The wire shapes of `protocol/sandbox/v1` in ratel-sdk that this module reads. */

export const RESERVED_SECRET_PREFIXES = ["RATEL_", "MODAL_", "AWS_"] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const secretNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/, "A secret name has the letters A to Z, digits and _.")
  .refine((name) => !RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)), {
    message: `The prefixes ${RESERVED_SECRET_PREFIXES.join(", ")} are reserved.`,
  });

export const manifestSchema = z.object({
  v: z.literal(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  entry: z.string().min(1).max(512).refine(isInsideProject, "entry must be inside the project"),
  base: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
  install: z.array(z.string().min(1).max(4096)).max(20),
  secrets: z
    .array(secretNameSchema)
    .max(50)
    .refine((names) => new Set(names).size === names.length, "a secret name is there two times"),
  tools: z
    .array(
      z
        .object({
          name: toolName,
          description: z.string().max(4096).optional(),
          sideEffect: z.boolean(),
          fake: z.boolean(),
        })
        .refine((tool) => !tool.sideEffect || tool.fake, {
          message: "a tool with side effects must have a fake handler",
        }),
    )
    .max(200),
});

export type SandboxManifest = z.infer<typeof manifestSchema>;

export const createVersionSchema = z.object({
  manifest: manifestSchema,
  git: z.object({
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    dirty: z.boolean(),
  }),
  bundle: z.object({ sha256, bytes: z.number().int().min(1) }),
});

export type CreateVersionInput = z.infer<typeof createVersionSchema>;

function isInsideProject(path: string): boolean {
  const parts = path.split(/[/\\]/);
  return parts[0] !== "" && !path.includes("\0") && !parts.includes("..");
}
