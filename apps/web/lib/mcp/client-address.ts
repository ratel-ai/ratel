/**
 * Which address a request arrived from, for the one limit that has to work
 * before the caller has proven who they are.
 *
 * The usual advice about `x-forwarded-for` is to read the leftmost entry,
 * because that is the original client. That advice is for logging, and it is
 * exactly wrong here: the header is caller-supplied, so anyone can arrive with
 * `X-Forwarded-For: <a million invented addresses>` and turn a per-address
 * budget into no budget at all.
 *
 * Our ALB *appends* the address of the peer that actually opened the
 * connection. The last entry is therefore the single hop nobody upstream could
 * forge, and it is the only one worth keying a limit on. A proxy chain in front
 * of the ALB would make it less precise (several callers could share it) but
 * never forgeable, which is the property that matters.
 */

/**
 * The bucket for requests with no forwarding header at all.
 *
 * Unreachable in front of the ALB, which always appends. Local development has
 * no proxy and lands here, sharing one bucket: conservative rather than open,
 * so a missing header can never be used as a way around the budget.
 */
export const UNKNOWN_CLIENT_ADDRESS = "unknown";

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return UNKNOWN_CLIENT_ADDRESS;

  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  return hops.at(-1) ?? UNKNOWN_CLIENT_ADDRESS;
}
