import { PermissionDeniedError } from "@anthropic-ai/sdk";

/**
 * A Bedrock model this AWS account may not call yet: its AWS Marketplace
 * agreement was never accepted. Bedrock answers 403 AccessDenied and names the
 * Marketplace actions. Nothing else can make that call succeed, so it fails
 * (decision not-enabled-fails), with a stable `errorType` for `model_call` and
 * the model and EU profile for the person who accepts the agreement.
 *
 * It is a `PermissionDeniedError`, so a call site that already stops on a
 * refused key stops on it too. A leaf module: the `model_call` recorder reads it
 * without importing the clients.
 */
export class ModelNotEnabledError extends PermissionDeniedError {
  readonly errorType = "model_not_enabled";

  constructor(
    /** The Anthropic model id the call site asked for. */
    readonly model: string,
    /** The Bedrock EU inference profile the call went to. */
    readonly bedrockProfile: string,
    cause: PermissionDeniedError,
  ) {
    super(
      403,
      cause.error,
      `Model ${model} is not enabled on Bedrock (${bedrockProfile}): its AWS Marketplace agreement is not accepted`,
      cause.headers,
    );
    this.name = "ModelNotEnabledError";
  }
}

/** Bedrock's AccessDenied words for a model with no Marketplace agreement. */
const MARKETPLACE_DENIED = /aws marketplace|aws-marketplace:/i;

/** `err` as `ModelNotEnabledError` when it is Bedrock's 403 for a missing Marketplace agreement, else `err` unchanged. */
export function asModelNotEnabled(err: unknown, model: string, bedrockProfile: string): unknown {
  if (!(err instanceof PermissionDeniedError) || err instanceof ModelNotEnabledError) return err;
  return MARKETPLACE_DENIED.test(err.message)
    ? new ModelNotEnabledError(model, bedrockProfile, err)
    : err;
}
