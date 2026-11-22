export interface ParamIssue {
  readonly param: string;
  readonly message: string;
}

/** One or more override values do not fit the sandbox's params. Maps to run.reject `invalid_params`. */
export class SandboxParamError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly sandboxId: string,
    readonly errors: readonly ParamIssue[],
  ) {
    super(`${sandboxId}: ${errors.map((e) => `${e.param} ${e.message}`).join("; ")}`);
    this.name = "SandboxParamError";
  }
}

/** The run input does not fit the sandbox's input kind (structured object, or chat `{ messages }`). */
export class SandboxInputError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly sandboxId: string,
    readonly problem: string,
  ) {
    super(`${sandboxId}: input ${problem}`);
    this.name = "SandboxInputError";
  }
}

/**
 * A `provider/model` value has no way to run here: no gateway key, no key for
 * its provider or no provider package. The message says what to set or install.
 */
export class ModelResolutionError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly modelId: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}
