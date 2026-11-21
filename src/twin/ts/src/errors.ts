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
