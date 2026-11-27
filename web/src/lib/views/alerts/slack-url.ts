const HOST = "hooks.slack.com";
const MAX_LENGTH = 500;

/** An incoming webhook's address, or null. Checked on save and again before each send. */
export function parseSlackWebhook(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowed =
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.length > 1;
  return allowed ? url : null;
}
