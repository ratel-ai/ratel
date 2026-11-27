/** A session route of the Datasets and Evals pages: the body, or the message of its refusal. */
export async function send<T>(
  method: "POST" | "PUT" | "DELETE" | "GET",
  url: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (response.ok) return { ok: true, data };
    return { ok: false, message: data.message ?? "Try again." };
  } catch {
    return { ok: false, message: "The request did not reach the server. Try again." };
  }
}

/** The base of the session routes of evals. */
export function evalsApi(projectId: string): string {
  return `/api/projects/${projectId}/evals`;
}
