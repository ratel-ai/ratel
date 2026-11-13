/**
 * Turn an account-authed route's failure (`{ status, reason }`) into a short,
 * human message for an inline banner. The `reason` codes come from
 * `mutationErrorResponse` in the catalog http helper.
 *
 * NOTE: the Skills editor and the Playground render their own copy for
 * `version_conflict` (a reload-and-reapply notice); this is the generic fallback.
 */
export function explainMutationError(status: number, reason?: string): string {
  switch (reason) {
    case "not_found":
      return "This item no longer exists. Refresh to see the latest.";
    case "name_conflict":
      return "A skill with that name already exists in this project.";
    case "version_conflict":
      return "This skill changed since you opened it. Refresh and try again.";
  }
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "Not found. Refresh to see the latest.";
  if (status === 0) return "Network error. Check your connection and try again.";
  return "Something went wrong. Try again.";
}
