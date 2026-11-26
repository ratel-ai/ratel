import { z } from "zod";

/**
 * The parsed `ratel.yaml` and the push request of `protocol/sandbox/v1` in ratel-sdk
 * (`ratel-yaml.schema.json`, `create-version.request.schema.json`). Unknown fields of the
 * configuration are refused, so a typo fails before a build.
 */

export const RESERVED_SECRET_PREFIXES = ["RATEL_", "BOAT_", "AWS_"] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/, "The path must be inside the folder of ratel.yaml.");
const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const secretNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "A secret name has the letters A to Z, digits and _.")
  .refine((name) => !RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)), {
    message: "The prefix of this name is reserved. Use another name.",
  });

const paramSchema = z
  .strictObject({
    type: z.enum(["string", "number", "boolean", "enum"]),
    default: scalar.optional(),
    description: z.string().optional(),
    options: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .refine(unique, "An option is there two times.")
      .optional(),
  })
  .superRefine((param, ctx) => {
    if (param.type === "enum" && !param.options) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "An enum needs options." });
    }
    if (param.type !== "enum" && param.options) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Only an enum has options." });
    }
    if (param.default === undefined) return;
    const fits =
      param.type === "enum"
        ? param.options?.includes(param.default as string | number)
        : typeof param.default === param.type;
    if (!fits) {
      const message =
        param.type === "enum"
          ? "The default must be one of the options."
          : `The default must be a ${param.type}.`;
      ctx.addIssue({ code: "custom", path: ["default"], message });
    }
  });

export const ratelYamlSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  image: z
    .union([
      z.strictObject({ dockerfile: relativePath.optional(), context: relativePath.optional() }),
      z.strictObject({ ref: z.string().regex(/^[^\s]+$/) }),
    ])
    .optional(),
  run: z
    .strictObject({
      mode: z.enum(["http", "command"]).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      command: z.array(z.string().min(1)).min(1).optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    })
    .refine((run) => run.mode !== "command" || run.command, {
      path: ["command"],
      message: "Command mode needs a command.",
    })
    .optional(),
  input: z
    .strictObject({
      example: z.unknown(),
      schema: z.record(z.string(), z.unknown()).optional(),
    })
    // Any JSON is an example, null too, but the field must be there.
    .refine((input) => Object.hasOwn(input, "example"), {
      path: ["example"],
      message: "The input needs an example.",
    }),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), paramSchema).optional(),
  secrets: z.array(secretNameSchema).refine(unique, "A secret name is there two times.").optional(),
  tools: z
    .record(
      z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
      z.strictObject({ mode: z.enum(["simulated", "recorded", "live"]).optional() }),
    )
    .optional(),
  network: z
    .strictObject({
      allow: z
        .array(z.string().regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/))
        .refine(unique, "A domain is there two times.")
        .optional(),
    })
    .optional(),
});

export type RatelYaml = z.infer<typeof ratelYamlSchema>;

export const createVersionSchema = z.object({
  config: ratelYamlSchema.refine(
    // Postgres does not store NUL.
    (config) => !JSON.stringify(config).includes("\\u0000"),
    "The configuration has a NUL character.",
  ),
  image: z.object({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    platform: z
      .string()
      .regex(/^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/)
      .optional(),
  }),
  git: z
    .object({
      commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      dirty: z.boolean(),
    })
    .optional(),
  bundle: z.object({ sha256, bytes: z.number().int().min(1) }),
});

export type CreateVersionInput = z.infer<typeof createVersionSchema>;

/** The names of the secrets that a configuration declares. */
export function secretNamesOf(config: RatelYaml): string[] {
  return config.secrets ?? [];
}

function unique(items: readonly unknown[]): boolean {
  return new Set(items).size === items.length;
}
