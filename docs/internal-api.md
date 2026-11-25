# Internal API

Routes for a service that stands in front of a Ratel deployment, such as an ingest gateway. They
are off by default and never take an API key.

This file is the one definition of these routes. Other implementations (Ratel Cloud's
`apps/web/lib/internal-auth`, the ingest gateway's client) follow it. A change here is a change
there.

## Access

- Set `RATEL_INTERNAL_SECRET` (`internal.secret`) to a random value of at least 32 characters.
- Send it as `Authorization: Bearer <value>`. It is compared in constant time.
- Unset or shorter: every internal route answers 404.
- A wrong or missing value: 401 `{"error": "Unauthorized."}`.

Do not publish the routes to clients: keep them out of any public path list of the load balancer.

## `POST /api/internal/keys/resolve`

Who an API key belongs to, and what its limits are.

Request: `{"keyHash": "<SHA-256 of the key, 64 lowercase hex characters>"}`. The key itself is never
sent. Never log the hash.

| Answer | Meaning |
|---|---|
| 200 `{"found": false}` | The key is unknown, revoked or expired. |
| 200, `found` true | See below. |
| 400 | The body is not as above. |
| 401, 404 | Access is wrong, or the route is off. Not an answer about the key. |
| 503, `Retry-After` | Ask again. Not an answer about the key. |

```json
{
  "found": true,
  "keyId": "uuid",
  "projectId": "uuid",
  "organizationId": "uuid",
  "scopes": ["*"],
  "ingest": ["ingest:traces", "ingest:logs", "ingest:events"],
  "expiresAt": null,
  "keyPolicy": {
    "access": "full",
    "publishable": false,
    "sharedKeyLimits": false,
    "appendOnlyIngest": false
  },
  "limits": { "shared": null, "events": { "perMinute": 120, "burst": 240 } },
  "quota": { "limit": 50000, "used": 1200, "exceeded": false }
}
```

- `scopes` are stored as they are; `*` is every scope. `ingest` is the list of ingest scopes the key
  may use, worked out by the key's policy. Use `ingest` to decide.
- `expiresAt` is ISO 8601 or null. A cache must not outlive it.
- `keyPolicy.appendOnlyIngest` and `keyPolicy.sharedKeyLimits` go into the envelope
  ([ADR 0010](adr/0010-kafka-ingest.md)).
- `limits` are token buckets: `perMinute` is the refill, `burst` the size.
  - `shared`, for a key with `sharedKeyLimits`, else null: `requests` and `items`, each with
    `perKey` and `perSource`. One budget for traces, logs and events together. A source is a key
    and an address (IPv6 by its /64). Charge the source first; a refused source does not charge
    the key.
  - `events`, for a secret key, else null: requests to `POST /api/v1/events`, per key.
- `quota` is the organization's monthly trace quota. It applies to traces only. `limit` null: there
  is none. `used` null: not reported. Decide with `exceeded`.

## `POST /api/internal/ingest/{traces|logs|events}`

Implemented by Ratel Cloud only, for the relay that delivers queued telemetry to it during the
migration. This core reads its queue itself ([ADR 0010](adr/0010-kafka-ingest.md)).

One request is one envelope. The body is the export as received, byte for byte, with the envelope's
`Content-Type` and `Content-Encoding`. The envelope's facts are headers:

| Header | Value |
|---|---|
| `x-ratel-envelope-id` | UUID. The raw capture's row id, so a redelivery adds no row. |
| `x-ratel-project-id` | UUID |
| `x-ratel-key-id` | UUID of the key's row |
| `x-ratel-received-at` | Unix milliseconds |
| `x-ratel-append-only-ingest` | `true` or `false` |

Other `x-ratel-*` headers are ignored. The receive time replaces "now" where ingest falls back to
it, tests for a future time or bounds a fact time. `received_at` columns stay the time of the store.
No limit and no quota refuses; usage is counted.

| Answer | For the relay |
|---|---|
| 202 | stored; commit |
| 422 `{"reason": "unknown_project"}` | final |
| 400, 413, 415 | final: a header, the body, its size or its type |
| 401, 404, 429, 500, 503 | retry. 404 is a deployment without the route, never an answer about the envelope |
| 503 with `Retry-After` | retry: off, on hold, or the database is away |

## `/api/internal/holds`

Holds an organization, or single projects, while its data is copied. Same shape in both apps.

- `POST {"action": "hold" | "clear", "organizationId": "uuid"}` or
  `{"action": …, "projectIds": ["uuid", …]}`: changes the state, and answers the status. A repeated
  call changes nothing.
- `GET ?organizationId=uuid` or `?projectId=uuid&projectId=uuid`: the status.
- 400: not as above. 404: an unknown project. Ratel Cloud also answers 404 for an unknown
  organization.
- This core holds, clears and reads an organization it does not have: the hold is set before a copy
  writes the first row, and covers the rows from the moment they arrive. `projectIds` is then empty.

```json
{
  "state": "none | held | moved",
  "since": "2026-11-25T20:00:00.000Z",
  "projectIds": ["uuid"],
  "runningJobs": 0,
  "queuedJobs": 3,
  "pendingSummarySpans": false,
  "openTransactions": 0,
  "settledAt": "2026-11-25T20:01:30.000Z",
  "quiet": true
}
```

`quiet` is the gate for the copy: no job runs, no request from before the hold can still be writing
(`settledAt` has passed), no open transaction is older than the hold, and every stored span is
summarised. `state` is `none` unless every project of the scope is on hold.

In Ratel Cloud a hold refuses every write (503, `Retry-After`), also relayed telemetry, and shows a
maintenance page in place of the console. Setting it also needs the `cloud-org-migration` flag;
reading and clearing do not.

Ratel Cloud also takes `"action": "move"`: the state becomes `moved`. Jobs and writes stay closed,
the workspace's people are sent to the same path in App, and Ratel's own people may look. `clear`
restores it, for the way back.

In this core a hold is the time from before the import to the opening. Telemetry is accepted and
stored, its jobs are queued, and no job runs. The scheduled sweeps skip the projects. The console
sends their readers to `/maintenance`; an operator in a support session may look. An API key keeps
its reads. Clearing the hold starts the jobs. `quiet` does not wait for `pendingSummarySpans` here,
and `state` is never `moved`.
