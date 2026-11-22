import type { GenerationInput, GenerationOutput } from "../domain/generation";

/** The small model that generates a fake. Ratel pays for the call. */
export interface FakeModel {
  generate(
    input: GenerationInput,
    meta: { projectId: string; organizationId: string | null },
  ): Promise<GenerationOutput>;
}
