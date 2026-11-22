export type RetrievalDescriptionAdoption = "runtime-owned" | "in-sync" | "pending-adoption";

export type RetrievalDescriptionAdoptionInput = {
  searchableDescription: string;
  searchableDescriptionOverride: string | null;
  useCloudDefinitions?: boolean | null;
};

export function getRetrievalDescriptionAdoption({
  searchableDescription,
  searchableDescriptionOverride,
  useCloudDefinitions,
}: RetrievalDescriptionAdoptionInput): RetrievalDescriptionAdoption {
  if (searchableDescriptionOverride === null) return "runtime-owned";
  if (useCloudDefinitions === true && searchableDescription === searchableDescriptionOverride) {
    return "in-sync";
  }
  return "pending-adoption";
}
