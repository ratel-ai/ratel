export interface ParamIssue {
  readonly param: string;
  readonly message: string;
}

/** One or more override values do not fit the twin's params. Maps to run.reject `invalid_params`. */
export class TwinParamError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly twinId: string,
    readonly errors: readonly ParamIssue[],
  ) {
    super(`${twinId}: ${errors.map((e) => `${e.param} ${e.message}`).join("; ")}`);
    this.name = "TwinParamError";
  }
}

/** The run input does not fit the twin's input kind (structured object, or chat `{ messages }`). */
export class TwinInputError extends Error {
  readonly reason = "invalid_params" as const;

  constructor(
    readonly twinId: string,
    readonly problem: string,
  ) {
    super(`${twinId}: input ${problem}`);
    this.name = "TwinInputError";
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
